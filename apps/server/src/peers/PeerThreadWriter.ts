/**
 * PeerThreadWriter - the write half of federation.
 *
 * Two operations:
 *
 * - `send` hands a message to another thread the way the operator's composer
 *   does: an idle thread starts a turn on it, a working thread receives it as
 *   part of the turn it is running. Available to every session.
 * - `create` makes a new thread on another machine and gives it its first
 *   instruction. Master-only.
 *
 * There was a third, `dispatch`, and it was deleted rather than kept. It
 * delivered its text bare — no sender, no machine, nothing marking it as coming
 * from an agent — so the recipient read it as its operator speaking. That is
 * precisely the confusion the envelope exists to prevent, and the justification
 * for it ("the master needs to interrupt work") stopped holding the moment
 * `send` began delivering immediately: the master can interrupt with `send`, and
 * the thread it interrupts gets to know who did it.
 *
 * `send` used to be queue-only, and the difference is worth stating because the
 * old shape is the one the fork was designed around. A mailbox message could not
 * cause a turn, which made agent-to-agent chatter structurally incapable of
 * looping — but it also meant an idle thread never read anything, because
 * nothing woke it. Coordination only worked when the operator happened to type
 * into the recipient by hand, which is not coordination. Immediate delivery
 * trades the structural guarantee for a working channel and buys part of it back
 * with a per-turn fan-out cap in `LocalThreadWriter`. What that cap does and does
 * not bound is written out above `make`, because the gap is real and should not
 * be discovered. `queue: true` still asks for the old behaviour outright.
 *
 * `peer` is optional on `send`, and omitting it addresses a thread on this
 * machine. That is not a convenience shim: threads on one machine need to talk
 * to each other as much as threads across machines do, and routing the local
 * case through the registry would have meant registering a machine as its own
 * peer just to say something to the thread next to it.
 *
 * @module PeerThreadWriter
 */
import {
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  PeerFederationError,
  type PeerFederationOperation,
  type PeerName,
  type PeerThreadCreateResult,
  type PeerThreadSendResult,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type ThreadMailboxOrigin,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { renderMailboxMessage } from "../mailbox/envelope.ts";
import { checkMailboxDelivery } from "../mailbox/intake.ts";
import { ThreadMailbox } from "../mailbox/ThreadMailbox.ts";
import { LocalThreadWriter } from "../threads/LocalThreadWriter.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  dispatchPeerCommand,
  fetchPeerProjectCatalog,
  fetchPeerShellSnapshot,
  sendPeerMailboxMessage,
} from "./PeerEnvironmentClient.ts";
import { PeerRegistry, type ResolvedPeer } from "./PeerRegistry.ts";
import {
  chooseProjectLocation,
  resolveThreadModelSelection,
  resolveThreadModes,
} from "./threadPlacement.ts";

export interface PeerThreadSendOptions {
  readonly peer?: PeerName | undefined;
  readonly threadId: ThreadId;
  readonly message: string;
  /** Provenance of the calling session; stamped onto the delivered envelope. */
  readonly origin: ThreadMailboxOrigin;
  /**
   * Ask for the old behaviour: leave the message waiting rather than delivering
   * it. Opt-in rather than default, because a message nobody is woken for is one
   * an idle thread may never read — which is the failure this send path exists
   * to remove, and not something a caller should get by saying nothing.
   */
  readonly queue?: boolean | undefined;
}

export interface PeerThreadCreateOptions {
  readonly peer: PeerName;
  /** The peer's own project id. Omit when `project` names one by slug instead. */
  readonly projectId?: ProjectId | undefined;
  /**
   * A project slug, resolved to whatever folder that peer binds under it.
   *
   * This is what makes cross-machine delegation say something an operator
   * recognises: "start this in alpamayo" rather than "start this in
   * 6b139d93-…". It also does the filing for free — the thread lands in a bound
   * location, so the peer derives its membership without anyone writing it.
   */
  readonly project?: string | undefined;
  readonly title: string;
  readonly message: string;
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}

export interface PeerThreadWriterShape {
  readonly sendMessage: (
    options: PeerThreadSendOptions,
  ) => Effect.Effect<PeerThreadSendResult, PeerFederationError>;
  readonly createThread: (
    options: PeerThreadCreateOptions,
  ) => Effect.Effect<PeerThreadCreateResult, PeerFederationError>;
}

export class PeerThreadWriter extends Context.Service<PeerThreadWriter, PeerThreadWriterShape>()(
  "t3/peers/PeerThreadWriter",
) {}

const failure = (
  operation: PeerFederationOperation,
  reason: PeerFederationError["reason"],
  peer?: PeerName,
  detail?: string,
) =>
  new PeerFederationError({
    operation,
    reason,
    ...(peer === undefined ? {} : { peer }),
    ...(detail === undefined ? {} : { detail }),
  });

/**
 * Maps a peer's HTTP rejection onto a federation reason. A 404 from the peer is
 * reported as `thread_not_found` rather than as a transport fault, because from
 * the agent's side those are genuinely different problems.
 */
const classifyPeerFailure = (
  operation: PeerFederationOperation,
  peer: PeerName,
  cause: Cause.Cause<unknown>,
): PeerFederationError => {
  const tags = new Set(
    cause.reasons.flatMap((reason) => {
      if (!Cause.isFailReason(reason)) return [];
      const error = reason.error;
      return typeof error === "object" && error !== null && "_tag" in error
        ? [String(error._tag)]
        : [];
    }),
  );
  if (tags.has("EnvironmentResourceNotFoundError")) {
    return failure(operation, "thread_not_found", peer);
  }
  if (tags.has("EnvironmentAuthInvalidError") || tags.has("EnvironmentScopeRequiredError")) {
    /**
     * Two different problems arrive as one rejection, and telling them apart is
     * the difference between a fix that works and an afternoon.
     *
     * `EnvironmentScopeRequiredError` means the peer understood the credential
     * and it does not carry the scope — a class problem, fixed by re-registering
     * as `operate`. `EnvironmentAuthInvalidError` means the peer would not
     * accept the credential at all, and by far the most common cause is that it
     * expired. This used to report both as the first, which sent the reader to
     * change a credential class that was already correct.
     */
    return tags.has("EnvironmentScopeRequiredError")
      ? failure(
          operation,
          "peer_unauthorized",
          peer,
          "Peer accepted this environment's credential but it lacks the scope for this operation; re-register the peer with the operate class.",
        )
      : failure(
          operation,
          "peer_unauthorized",
          peer,
          "Peer rejected this environment's credential outright — most often because it has expired or been revoked. Re-register the peer to mint a new one; check its credentialExpiresAt in the peers list to confirm.",
        );
  }
  if (tags.has("EnvironmentRequestInvalidError")) {
    return failure(operation, "message_rejected", peer, "Peer refused the message.");
  }
  if (tags.has("EnvironmentInternalError")) {
    // The peer was reached and answered — it just failed on its own side.
    // Reporting that as "unreachable" sends an operator to check the network
    // when they should be reading the peer's logs.
    return failure(operation, "message_rejected", peer, "Peer failed to process the request.");
  }
  return failure(operation, "peer_unreachable", peer, Cause.pretty(cause));
};

/**
 * What bounds a runaway conversation, and what deliberately does not.
 *
 * `THREAD_WAKE_PER_TURN_LIMIT` in `LocalThreadWriter` bounds width: how many
 * threads one turn may wake. Nothing bounds depth, on purpose. Fan-out is
 * exponential and outruns the operator; a chain is linear, one turn at a time,
 * each costing minutes and money in plain view — and two threads talking until
 * they are done is the feature rather than the failure.
 *
 * Both a rolling per-target rate limit and a chain-depth cap were built and
 * removed before shipping. The rate limit could not work: an agent turn takes
 * minutes, so a ping-pong never trips a limit loose enough to permit a
 * legitimate burst. The depth cap worked and was worse — past the limit a
 * message downgraded to the mailbox, which for an idle thread is the unread
 * state this whole path exists to eliminate, so the guard broke conversations in
 * exactly the way the old default did.
 */
export const make = Effect.gen(function* () {
  const registry = yield* PeerRegistry;
  const httpClient = yield* HttpClient.HttpClient;
  const mailbox = yield* ThreadMailbox;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const localThreadWriter = yield* LocalThreadWriter;

  /**
   * Resolves a peer and asserts it is writable. The class check is what keeps
   * a read-only registration from being used for writes: even though the peer
   * would reject the call on scope anyway, refusing locally gives the agent a
   * reason it can act on instead of an opaque 403 from another machine.
   */
  const resolveOperablePeer = Effect.fn("PeerThreadWriter.resolveOperablePeer")(function* (
    operation: PeerFederationOperation,
    peer: PeerName,
  ): Effect.fn.Return<ResolvedPeer, PeerFederationError> {
    const resolved = yield* registry
      .resolve(peer)
      .pipe(Effect.mapError(() => failure(operation, "registry_unavailable", peer)));
    if (Option.isNone(resolved)) {
      return yield* failure(operation, "peer_not_found", peer);
    }
    if (resolved.value.peer.credentialClass !== "operate") {
      return yield* failure(
        operation,
        "peer_not_operable",
        peer,
        "This peer is registered read-only. Re-register it with the operate credential class to write to it.",
      );
    }
    return resolved.value;
  });

  /**
   * Hands the message to a thread on this machine. `false` means the caller
   * should queue it instead — either because the sender asked to, because the
   * sender's per-turn allowance is spent, or because the engine refused.
   */
  const wakeLocally = Effect.fn("PeerThreadWriter.wakeLocally")(function* (input: {
    readonly callerThreadId: ThreadId | null;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly queue: boolean;
  }) {
    if (input.queue) return false;
    // A caller whose own thread could not be resolved cannot be charged a
    // per-turn allowance, and an uncharged wake is an unbounded one. Queueing is
    // the safe reading of "I do not know who is asking".
    if (input.callerThreadId === null) return false;

    const outcome = yield* localThreadWriter
      .deliverMessage({
        callerThreadId: input.callerThreadId,
        threadId: input.threadId,
        text: input.text,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not deliver a thread message immediately; queueing it", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as("rate_limited" as const)),
        ),
      );
    return outcome === "delivered";
  });

  /** The same, for a thread on a peer. `false` means fall back to its mailbox. */
  const wakeRemotely = Effect.fn("PeerThreadWriter.wakeRemotely")(function* (input: {
    readonly peer: PeerName;
    readonly callerThreadId: ThreadId | null;
    readonly baseUrl: string;
    readonly credential: string;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly queue: boolean;
  }) {
    if (input.queue) return false;
    // The same budget the local path spends, and for the same reason: fan-out is
    // the shape that runs away, and it does not become safe by crossing a
    // machine boundary. Charging a separate counter here would let one turn wake
    // the per-turn limit locally *and* the limit again on every peer.
    if (input.callerThreadId === null) return false;
    if (!(yield* localThreadWriter.chargeWakeAllowance(input.callerThreadId))) return false;

    const command = {
      type: "thread.turn.start",
      commandId: CommandId.make(`peer-deliver-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
        role: "user",
        // Stamped here and honoured by the peer's own decider, so a delivered
        // message is marked as an agent's on the machine that stores it rather
        // than only on the one that sent it.
        authoredBy: "agent",
        text: input.text,
        attachments: [],
      },
      // Ballast, for the reason `dispatchThread` documents: the peer's decider
      // reads the target thread's own stored modes and ignores these.
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    } as unknown as ClientOrchestrationCommand;

    return yield* dispatchPeerCommand({
      baseUrl: input.baseUrl,
      credential: input.credential,
      command,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.as(true),
      // Deliberately quiet: the mailbox fallback that follows hits the same
      // machine over the same credential, so a real fault surfaces there with a
      // classified reason. Logged rather than dropped so a peer that only fails
      // the dispatch route is still visible.
      Effect.catchCause((cause) =>
        Effect.logWarning("could not deliver a peer thread message immediately; queueing it", {
          peer: input.peer,
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
  });

  const sendMessage: PeerThreadWriterShape["sendMessage"] = Effect.fn(
    "PeerThreadWriter.sendMessage",
  )(function* (options) {
    const sentAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    /**
     * What the thread actually receives, rendered once and used by whichever
     * path takes it. The envelope is not decoration on the immediate path — it
     * is the entire reason a message from another agent is distinguishable from
     * one the operator typed, and both paths must state that boundary the same
     * way or the distinction becomes a function of timing.
     */
    const envelope = renderMailboxMessage({
      message: options.message,
      origin: options.origin,
      sentAt,
    });

    if (options.peer === undefined) {
      const environmentId = yield* environment.getEnvironmentId;
      yield* checkMailboxDelivery({
        threadId: options.threadId,
        origin: options.origin,
        environmentId,
        projectionSnapshotQuery,
      }).pipe(
        Effect.mapError((error) =>
          error.reason === "self_delivery"
            ? failure("send", "self_delivery_refused", undefined, error.detail)
            : error.reason === "thread_not_found"
              ? failure("send", "thread_not_found", undefined, error.detail)
              : failure("send", "registry_unavailable", undefined, error.detail),
        ),
      );

      /**
       * Delivery is attempted before the mailbox is touched, so the common case
       * writes no row at all. Falling through to the queue costs nothing that
       * was already spent: nothing has been persisted and nothing has reached
       * the target.
       */
      const delivered = yield* wakeLocally({
        callerThreadId: options.origin.threadId,
        threadId: options.threadId,
        text: envelope,
        queue: options.queue === true,
      });
      if (delivered) {
        return {
          peer: null,
          threadId: options.threadId,
          delivery: "now",
          pending: 0,
          deliveredAt: sentAt,
        };
      }

      const accepted = yield* mailbox
        .enqueue({
          threadId: options.threadId,
          message: options.message,
          origin: options.origin,
          sentAt,
        })
        .pipe(
          Effect.mapError((error) =>
            error.reason === "mailbox_full"
              ? failure("send", "mailbox_full", undefined, error.detail)
              : failure("send", "peer_unreachable", undefined, error.detail),
          ),
        );
      return {
        peer: null,
        threadId: options.threadId,
        delivery: "queued",
        pending: accepted.pending,
        deliveredAt: null,
      };
    }

    const { peer, credential } = yield* resolveOperablePeer("send", options.peer);

    const woken = yield* wakeRemotely({
      peer: peer.name,
      callerThreadId: options.origin.threadId,
      baseUrl: peer.baseUrl,
      credential,
      threadId: options.threadId,
      text: envelope,
      queue: options.queue === true,
    });
    if (woken) {
      return {
        peer: peer.name,
        threadId: options.threadId,
        delivery: "now",
        pending: 0,
        deliveredAt: sentAt,
      };
    }

    /**
     * The fallback doubles as the error path, which is why the wake above is
     * allowed to fail quietly. This call reaches the same machine over the same
     * credential, so a peer that is down, unauthorised, or does not have the
     * thread fails here too — and fails with the reason `classifyPeerFailure`
     * gives it, rather than with whatever a swallowed dispatch would have said.
     */
    const result = yield* sendPeerMailboxMessage({
      baseUrl: peer.baseUrl,
      credential,
      threadId: options.threadId,
      payload: { message: options.message, origin: options.origin, sentAt },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.catchCause((cause) =>
        Effect.fail(classifyPeerFailure("send", peer.name, cause as Cause.Cause<unknown>)),
      ),
    );
    return {
      peer: peer.name,
      threadId: options.threadId,
      delivery: "queued",
      pending: result.pending,
      deliveredAt: null,
    };
  });

  /**
   * Turn-start with a `bootstrap.createThread` block: one dispatch that creates
   * the thread and gives it its first message. A bare `thread.create` would
   * leave a thread sitting idle until something else woke it, which is not what
   * "start this work" means.
   */
  const createThread: PeerThreadWriterShape["createThread"] = Effect.fn(
    "PeerThreadWriter.createThread",
  )(function* (options) {
    const { peer, credential } = yield* resolveOperablePeer("create", options.peer);

    const snapshot = yield* fetchPeerShellSnapshot({ baseUrl: peer.baseUrl, credential }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.catchCause((cause) =>
        Effect.fail(classifyPeerFailure("create", peer.name, cause as Cause.Cause<unknown>)),
      ),
    );

    /**
     * A slug names a project; the peer decides which of its folders that is.
     *
     * Resolved against the peer's own catalog rather than this machine's,
     * because the binding is the peer's to hold — the same project can be a
     * different folder on every machine, and that asymmetry is the whole reason
     * the catalog splits display from local.
     *
     * The category also carries the defaults the operator set for threads
     * started in this project *there*, which is why it is kept rather than
     * discarded after yielding an id: a thread delegated into a project should
     * start as a thread started by hand in that project would.
     */
    const placement =
      options.project === undefined
        ? null
        : yield* Effect.gen(function* () {
            const catalog = yield* fetchPeerProjectCatalog({
              baseUrl: peer.baseUrl,
              credential,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.catchCause((cause) =>
                Effect.fail(
                  classifyPeerFailure("create", peer.name, cause as Cause.Cause<unknown>),
                ),
              ),
            );
            const category = catalog.categories.find((entry) => entry.slug === options.project);
            if (category === undefined) {
              return yield* failure(
                "create",
                "project_not_found",
                peer.name,
                `Peer has no project '${options.project}'. Its projects are: ${
                  catalog.categories.map((entry) => entry.slug).join(", ") || "(none)"
                }.`,
              );
            }
            const choice = chooseProjectLocation(category);
            // A category with no binding here is a legal state — it is how a
            // research project with no folder of its own looks — but it is not
            // somewhere a thread can be created, and saying so beats picking a
            // folder the operator never bound.
            if (choice.kind === "unbound") {
              return yield* failure(
                "create",
                "project_not_found",
                peer.name,
                `Peer knows project '${options.project}' but binds no folder to it, so there is nowhere to start the thread. Bind a location there first, or pass projectId.`,
              );
            }
            // Several folders and nothing on the peer saying which. Refused
            // rather than settled by the order the file happened to list them,
            // because a thread started in the wrong checkout is invisible from
            // inside the call that started it.
            if (choice.kind === "ambiguous") {
              return yield* failure(
                "create",
                "project_not_found",
                peer.name,
                `Peer binds ${choice.projectIds.length} folders to project '${options.project}' and names no preferred one, so which to start the thread in is ambiguous. Pass projectId — the candidates are: ${choice.projectIds.join(", ")}.`,
              );
            }
            return { projectId: choice.projectId, category };
          });

    const projectId = placement === null ? options.projectId : placement.projectId;

    if (projectId === undefined) {
      return yield* failure(
        "create",
        "project_not_found",
        peer.name,
        "Pass either project (a slug) or projectId (the peer's own id) to say where the thread should start.",
      );
    }

    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      return yield* failure(
        "create",
        "project_not_found",
        peer.name,
        `Peer has no project '${projectId}'. Its projects are: ${snapshot.projects.map((candidate) => candidate.id).join(", ")}.`,
      );
    }

    // Three layers, weakest first: the folder's default, the project category's
    // — which is where the operator actually configures a project, and which
    // this used to ignore entirely — then whatever the caller named outright.
    const overrides = {
      instanceId: options.instanceId,
      model: options.model,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
    };
    const modelSelection = resolveThreadModelSelection({
      locationDefault: project.defaultModelSelection,
      categoryDefault: placement?.category.local.defaults.modelSelection,
      overrides,
    });
    if (modelSelection === null) {
      return yield* failure(
        "create",
        "message_rejected",
        peer.name,
        `Project '${projectId}' has no default model, so instanceId and model must both be given.`,
      );
    }

    const threadId = ThreadId.make(`thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
    const commandId = CommandId.make(
      `peer-create-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    );
    const messageId = MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const { runtimeMode, interactionMode } = resolveThreadModes({
      ...(placement === null ? {} : { category: placement.category }),
      overrides,
    });

    const send = (command: ClientOrchestrationCommand) =>
      dispatchPeerCommand({ baseUrl: peer.baseUrl, credential, command }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catchCause((cause) =>
          Effect.fail(classifyPeerFailure("create", peer.name, cause as Cause.Cause<unknown>)),
        ),
      );

    // Two dispatches rather than one `thread.turn.start` carrying a
    // `bootstrap.createThread` block, for the reason `LocalThreadWriter`'s
    // module docstring sets out at length: the block is unpacked only by
    // `ws.ts`, and what that handler does with it — worktrees, setup scripts,
    // cleanup-on-failure — is not something the engine should learn. The thread
    // is created first and told what to do second.
    yield* send({
      type: "thread.create",
      commandId,
      threadId,
      projectId: projectId,
      title: options.title,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: null,
      worktreePath: null,
      createdAt,
    } as unknown as ClientOrchestrationCommand);

    yield* send({
      type: "thread.turn.start",
      commandId: CommandId.make(`peer-first-turn-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
      threadId,
      message: { messageId, role: "user", text: options.message, attachments: [] },
      runtimeMode,
      interactionMode,
      createdAt,
    } as unknown as ClientOrchestrationCommand);

    return {
      peer: peer.name,
      threadId,
      projectId: projectId,
      title: options.title,
    } as PeerThreadCreateResult;
  });

  return { sendMessage, createThread } satisfies PeerThreadWriterShape;
});

export const layer: Layer.Layer<
  PeerThreadWriter,
  never,
  | PeerRegistry
  | HttpClient.HttpClient
  | ThreadMailbox
  | Crypto.Crypto
  | ProjectionSnapshotQuery
  | ServerEnvironment.ServerEnvironment
  | LocalThreadWriter
> = Layer.effect(PeerThreadWriter, make);
