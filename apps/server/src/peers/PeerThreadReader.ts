/**
 * PeerThreadReader - bounded reads of peer threads.
 *
 * Sits between the peer registry and any caller (today: the MCP toolkit) and
 * owns the two invariants federation must not lose: one unreachable peer never
 * fails a whole listing, and no read is unbounded — every result is capped and
 * paged before it can reach an agent's context.
 *
 * @module PeerThreadReader
 */
import {
  PEER_THREADS_LIST_DEFAULT,
  PEER_THREADS_LIST_MAX,
  PEER_THREAD_READ_DEFAULT_ENTRIES,
  PEER_THREAD_READ_MAX_ENTRIES,
  PeerFederationError,
  type PeerName,
  type PeerQueryFailure,
  type PeerThreadCursor,
  type PeerThreadReadResult,
  type PeerThreadSummary,
  type PeerThreadsListResult,
  type PeerThreadsOrder,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { fetchPeerShellSnapshot, fetchPeerThreadSnapshot } from "./PeerEnvironmentClient.ts";
import { PeerRegistry, type ResolvedPeer } from "./PeerRegistry.ts";
import {
  applyPeerThreadCursor,
  comparePeerThreadsByActivity,
  comparePeerThreadsByCreation,
  renderPeerTranscript,
  resolvePeerThreadStatus,
  summarizePeerThread,
} from "./transcript.ts";

export interface PeerThreadReaderShape {
  readonly listThreads: (options: {
    readonly peer?: PeerName | undefined;
    readonly limit?: number | undefined;
    readonly order?: PeerThreadsOrder | undefined;
    readonly cursor?: PeerThreadCursor | undefined;
  }) => Effect.Effect<PeerThreadsListResult, PeerFederationError>;
  readonly readThread: (options: {
    readonly peer: PeerName;
    readonly threadId: ThreadId;
    readonly limit?: number | undefined;
    readonly before?: number | undefined;
  }) => Effect.Effect<PeerThreadReadResult, PeerFederationError>;
}

export class PeerThreadReader extends Context.Service<PeerThreadReader, PeerThreadReaderShape>()(
  "t3/peers/PeerThreadReader",
) {}

const clampLimit = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined ? fallback : Math.min(Math.max(Math.trunc(value), 1), max);

/**
 * Peers report their own auth failures as typed contract errors; anything else
 * (DNS, refused connection, timeout) is a reachability problem. Distinguishing
 * the two is what tells an operator whether to re-pair or to start the machine.
 */
const isUnauthorizedFailure = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    return (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error._tag === "EnvironmentAuthInvalidError" ||
        error._tag === "EnvironmentScopeRequiredError")
    );
  });

const isThreadNotFound = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    return (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "EnvironmentResourceNotFoundError"
    );
  });

export const make = Effect.gen(function* () {
  const registry = yield* PeerRegistry;
  const httpClient = yield* HttpClient.HttpClient;

  const registryUnavailable = (operation: "list" | "read", cause: unknown) =>
    new PeerFederationError({
      operation,
      reason: "registry_unavailable",
      detail: Cause.pretty(Cause.fail(cause)),
    });

  const resolvePeer = (operation: "list" | "read", name: PeerName) =>
    registry.resolve(name).pipe(
      Effect.mapError((cause) => registryUnavailable(operation, cause)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PeerFederationError({ operation, reason: "peer_not_found", peer: name }),
            ),
          onSome: Effect.succeed<ResolvedPeer>,
        }),
      ),
    );

  const listThreads: PeerThreadReaderShape["listThreads"] = Effect.fn(
    "PeerThreadReader.listThreads",
  )(function* (options) {
    const limit = clampLimit(options.limit, PEER_THREADS_LIST_DEFAULT, PEER_THREADS_LIST_MAX);
    const order = options.order ?? "activity";
    if (options.cursor !== undefined && order !== "created") {
      return yield* new PeerFederationError({
        operation: "list",
        reason: "cursor_requires_created_order",
        detail:
          "Activity order is a ranked head, not a traversable sequence — there is no last_activity_at column to key a cursor on. Pass order=created to page.",
      });
    }
    const registered = yield* registry.list.pipe(
      Effect.mapError((cause) => registryUnavailable("list", cause)),
    );

    const targets =
      options.peer === undefined
        ? registered
        : registered.filter((peer) => peer.name === options.peer);

    if (targets.length === 0) {
      return yield* new PeerFederationError({
        operation: "list",
        reason: options.peer === undefined ? "no_peers_registered" : "peer_not_found",
        ...(options.peer === undefined ? {} : { peer: options.peer }),
      });
    }

    const results = yield* Effect.forEach(
      targets,
      (peer) =>
        resolvePeer("list", peer.name).pipe(
          Effect.flatMap((resolved) =>
            fetchPeerShellSnapshot({
              baseUrl: resolved.peer.baseUrl,
              credential: resolved.credential,
            }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
          ),
          Effect.map((snapshot) =>
            snapshot.threads.map((thread) => summarizePeerThread(peer.name, thread)),
          ),
          // One dead machine must not sink the listing: degrade to a reported
          // failure so the agent still sees every reachable peer's threads.
          Effect.matchCause({
            onFailure: (cause) => ({
              threads: [] as ReadonlyArray<PeerThreadSummary>,
              failure: {
                peer: peer.name,
                reason: isUnauthorizedFailure(cause)
                  ? "Peer rejected this environment's credential; re-register the peer."
                  : "Peer is unreachable.",
              } satisfies PeerQueryFailure as PeerQueryFailure | null,
            }),
            onSuccess: (threads) => ({
              threads: threads as ReadonlyArray<PeerThreadSummary>,
              failure: null as PeerQueryFailure | null,
            }),
          }),
        ),
      { concurrency: "unbounded" },
    );

    const merged = results
      .flatMap((result) => result.threads)
      .toSorted(order === "created" ? comparePeerThreadsByCreation : comparePeerThreadsByActivity);
    const eligible =
      options.cursor === undefined ? merged : applyPeerThreadCursor(merged, options.cursor);
    const page = eligible.slice(0, limit);
    const last = page.at(-1);

    return {
      threads: page,
      totalAvailable: eligible.length,
      peersQueried: targets.map((peer) => peer.name),
      failures: results
        .map((result) => result.failure)
        .filter((failure): failure is PeerQueryFailure => failure !== null),
      order,
      // Only a creation-ordered page can be resumed; an activity-ranked head
      // would silently reorder underneath the cursor.
      nextCursor:
        order === "created" && last !== undefined && eligible.length > page.length
          ? { createdAt: last.createdAt, threadId: last.threadId }
          : null,
    } satisfies PeerThreadsListResult;
  });

  const readThread: PeerThreadReaderShape["readThread"] = Effect.fn("PeerThreadReader.readThread")(
    function* (options) {
      const limit = clampLimit(
        options.limit,
        PEER_THREAD_READ_DEFAULT_ENTRIES,
        PEER_THREAD_READ_MAX_ENTRIES,
      );
      const resolved = yield* resolvePeer("read", options.peer);
      const snapshot = yield* fetchPeerThreadSnapshot({
        baseUrl: resolved.peer.baseUrl,
        credential: resolved.credential,
        threadId: options.threadId,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catchCause((cause) =>
          Effect.fail(
            new PeerFederationError({
              operation: "read",
              reason: isThreadNotFound(cause)
                ? "thread_not_found"
                : isUnauthorizedFailure(cause)
                  ? "peer_unauthorized"
                  : "peer_unreachable",
              peer: options.peer,
              detail: Cause.pretty(cause),
            }),
          ),
        ),
      );

      const thread = snapshot.thread;
      const page = renderPeerTranscript(thread, {
        limit,
        ...(options.before === undefined ? {} : { before: options.before }),
      });

      return {
        peer: options.peer,
        threadId: thread.id,
        title: thread.title,
        status: resolvePeerThreadStatus({
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          latestTurn: thread.latestTurn,
          session: thread.session,
          archivedAt: thread.archivedAt,
          settledAt: thread.settledAt,
          settledOverride: thread.settledOverride,
        }),
        provider: thread.session?.providerName ?? thread.modelSelection.instanceId ?? null,
        totalEntries: page.totalEntries,
        entries: page.entries,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
      } satisfies PeerThreadReadResult;
    },
  );

  return PeerThreadReader.of({ listThreads, readThread });
});

export const layer: Layer.Layer<PeerThreadReader, never, PeerRegistry | HttpClient.HttpClient> =
  Layer.effect(PeerThreadReader, make);
