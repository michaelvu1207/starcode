/**
 * ThreadService - the single server-side thread lifecycle facade.
 *
 * Protocol bindings pass thread ids, never peer names, for reads and sends.
 * This service owns local-vs-remote resolution and keeps a small location
 * index warm from every list. FleetClient is its only node transport and local
 * work goes straight to orchestration/mailbox services.
 *
 * @module ThreadService
 */
import {
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  PeerFederationError,
  type PeerFederationOperation,
  PeerName,
  type ProjectCategoryRecord,
  THREADS_LIST_DEFAULT,
  THREADS_LIST_MAX,
  THREAD_READ_DEFAULT_ENTRIES,
  THREAD_READ_MAX_ENTRIES,
  type ThreadCursor,
  type ThreadsOrder,
  type ProjectCategorySlug,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadCreateInput,
  ThreadId,
  type ThreadMailboxOrigin,
  ThreadNode,
  type ThreadQueryFailure,
  type ThreadReadResult,
  type ThreadSendResult,
  type ThreadServiceCreateResult,
  type ThreadSummary,
  type ThreadsListResult,
  type FleetThreadIndexEntry,
  type FleetThreadIndexFailure,
  FleetNodeName,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationCommand,
  ThreadLifecycleDispatchError,
} from "@starcode/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  dispatchFleetCommand,
  fetchFleetProjectCatalog,
  fetchFleetShellSnapshot,
  fetchFleetThreadSnapshot,
  sendFleetMailboxMessage,
} from "../fleet/FleetClient.ts";
import { FleetRegistry } from "../fleet/FleetRegistry.ts";
import { FleetThreadIndex } from "../fleet/FleetThreadIndex.ts";
import { renderMailboxMessage } from "../mailbox/envelope.ts";
import { checkMailboxDelivery } from "../mailbox/intake.ts";
import { ThreadMailbox } from "../mailbox/ThreadMailbox.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  chooseProjectLocation,
  resolveThreadModelSelection,
  resolveThreadModes,
} from "../peers/threadPlacement.ts";
import {
  applyPeerThreadCursor,
  comparePeerThreadsByActivity,
  comparePeerThreadsByCreation,
  peerProjectByThread,
  renderPeerTranscript,
  resolvePeerThreadStatus,
  summarizePeerThread,
} from "../peers/transcript.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";

export interface ThreadServiceListOptions {
  readonly node?: ThreadNode | undefined;
  readonly limit?: number | undefined;
  readonly order?: ThreadsOrder | undefined;
  readonly cursor?: ThreadCursor | undefined;
  readonly project?: ProjectCategorySlug | undefined;
}

export interface ThreadServiceReadOptions {
  readonly threadId: ThreadId;
  readonly limit?: number | undefined;
  readonly before?: number | undefined;
}

export interface ThreadServiceSendOptions {
  readonly threadId: ThreadId;
  readonly message: string;
  readonly origin: ThreadMailboxOrigin;
  readonly queue?: boolean | undefined;
}

export interface ThreadServiceCreateOptions extends Omit<
  ThreadCreateInput,
  "node" | "projectId" | "project"
> {
  readonly callerThreadId: ThreadId;
  readonly node?: ThreadNode | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly project?: ProjectCategorySlug | undefined;
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}

export interface ThreadServiceShape {
  readonly listThreads: (
    options: ThreadServiceListOptions,
  ) => Effect.Effect<ThreadsListResult, PeerFederationError>;
  readonly readThread: (
    options: ThreadServiceReadOptions,
  ) => Effect.Effect<ThreadReadResult, PeerFederationError>;
  readonly sendMessage: (
    options: ThreadServiceSendOptions,
  ) => Effect.Effect<ThreadSendResult, PeerFederationError>;
  readonly createThread: (
    options: ThreadServiceCreateOptions,
  ) => Effect.Effect<ThreadServiceCreateResult, PeerFederationError>;
  /** Thin local read used by the authenticated environment HTTP binding. */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, PeerFederationError>;
  readonly dispatchCreate: (
    command: Extract<OrchestrationCommand, { readonly type: "thread.create" }>,
  ) => Effect.Effect<{ readonly sequence: number }, ThreadLifecycleDispatchError>;
  readonly startTurn: (
    command: Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>,
  ) => Effect.Effect<{ readonly sequence: number }, ThreadLifecycleDispatchError>;
  readonly setArchived: (
    command: Extract<
      OrchestrationCommand,
      { readonly type: "thread.archive" | "thread.unarchive" }
    >,
  ) => Effect.Effect<{ readonly sequence: number }, ThreadLifecycleDispatchError>;
  /**
   * Refresh this node's authoritative entries without waiting for the periodic
   * fleet reconcile loop.
   */
  readonly refreshLocalIndex: Effect.Effect<void, PeerFederationError>;
  /** Compatibility name retained for the one-release migration window. */
  readonly refreshIndex: Effect.Effect<void, PeerFederationError>;
}

export class ThreadService extends Context.Service<ThreadService, ThreadServiceShape>()(
  "starcode/threads/ThreadService",
) {}

/** Per-caller, per-turn runaway backstops owned by the canonical service. */
export const LOCAL_THREAD_CREATE_PER_TURN_LIMIT = 3;
export const THREAD_WAKE_PER_TURN_LIMIT = 5;

interface LocalNode {
  readonly node: ThreadNode;
  readonly aliases: ReadonlySet<string>;
}

interface ThreadLocation {
  readonly node: ThreadNode;
  readonly local: boolean;
}

interface FleetThreadTarget {
  readonly node: ThreadNode;
  readonly baseUrl: string;
  readonly credential: string;
}

interface TurnAllowance {
  readonly key: string;
  readonly used: number;
}

const clampLimit = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined ? fallback : Math.min(Math.max(Math.trunc(value), 1), max);

const federationFailure = (
  operation: "list" | "read" | "send" | "create",
  reason: ConstructorParameters<typeof PeerFederationError>[0]["reason"],
  detail?: string,
  peer?: string,
) =>
  new PeerFederationError({
    operation,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(peer === undefined ? {} : { peer }),
  });

const safeFederationDetail = (
  reason: ConstructorParameters<typeof PeerFederationError>[0]["reason"],
): string => {
  switch (reason) {
    case "no_peers_registered":
      return "No fleet nodes are registered.";
    case "peer_not_found":
      return "The owning fleet node is unavailable.";
    case "peer_unreachable":
      return "The owning fleet node is unreachable.";
    case "peer_unauthorized":
    case "peer_not_operable":
      return "The owning fleet node rejected this operation.";
    case "thread_not_found":
      return "No fleet node reported this thread.";
    case "capability_unavailable":
      return "The requested thread capability is unavailable.";
    case "registry_unavailable":
      return "The fleet thread registry is unavailable.";
    case "cursor_requires_created_order":
      return "A cursor requires created-order listing.";
    case "self_delivery_refused":
      return "A thread cannot deliver a message to itself.";
    case "mailbox_full":
      return "The destination mailbox is full.";
    case "project_not_found":
      return "The selected project is unavailable on the target node.";
    case "message_rejected":
      return "The target thread rejected the message.";
    case "project_scope_ambiguous":
      return "The requested project scope is ambiguous.";
    case "caller_project_unknown":
      return "The caller's project could not be resolved.";
  }
};

const sanitizeFederationError = (error: PeerFederationError): PeerFederationError =>
  new PeerFederationError({
    operation: error.operation,
    reason: error.reason,
    ...(error.peer === undefined ? {} : { peer: error.peer }),
    detail: safeFederationDetail(error.reason),
  });

const classifyFleetFailure = (
  operation: PeerFederationOperation,
  node: ThreadNode,
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
  const peer = String(node);
  if (tags.has("EnvironmentResourceNotFoundError")) {
    return federationFailure(operation, "thread_not_found", "The thread was not found.", peer);
  }
  if (tags.has("EnvironmentAuthInvalidError") || tags.has("EnvironmentScopeRequiredError")) {
    return federationFailure(
      operation,
      "peer_unauthorized",
      "The owning fleet node rejected this operation.",
      peer,
    );
  }
  if (tags.has("EnvironmentRequestInvalidError") || tags.has("EnvironmentInternalError")) {
    return federationFailure(
      operation,
      "message_rejected",
      "The owning fleet node could not process this operation.",
      peer,
    );
  }
  return federationFailure(
    operation,
    "peer_unreachable",
    "The owning fleet node is unreachable.",
    peer,
  );
};

const fleetFailureReason = (failure: FleetThreadIndexFailure): string => {
  switch (failure.reason) {
    case "unreachable":
      return "Fleet node is unreachable.";
    case "unauthorized":
      return "Fleet node rejected the index refresh.";
    case "unavailable":
      return "Fleet node is unavailable.";
  }
};

const indexedThreadSummary = (entry: FleetThreadIndexEntry, local: boolean): ThreadSummary => ({
  node: ThreadNode.make(entry.nodeName),
  local,
  threadId: entry.threadId,
  title: entry.title,
  provider: entry.provider,
  model: entry.model,
  status: entry.status,
  lastActivityAt: entry.lastActivityAt,
  createdAt: entry.createdAt,
  branch: entry.branch,
  ...(entry.planSummary === undefined ? {} : { planSummary: entry.planSummary }),
  project: entry.project,
});

const toThreadSummary = (
  summary: ReturnType<typeof summarizePeerThread>,
  local: boolean,
): ThreadSummary => {
  const { peer, ...rest } = summary;
  return { node: peer, local, ...rest };
};

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fleetThreadIndex = yield* FleetThreadIndex;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectCatalog = yield* ProjectCatalogRegistry;
  const fleetRegistry = yield* FleetRegistry;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const mailbox = yield* ThreadMailbox;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const locations = yield* SynchronizedRef.make(new Map<ThreadId, ThreadLocation>());

  const descriptor = yield* environment.getDescriptor;
  const localNode: LocalNode = {
    node: ThreadNode.make(descriptor.environmentId),
    aliases: new Set(["local", descriptor.environmentId, descriptor.label]),
  };
  const isLocalNode = (node: ThreadNode | undefined): boolean =>
    node === undefined || localNode.aliases.has(node);

  const makeAllowance = (limit: number) =>
    Effect.map(SynchronizedRef.make(new Map<string, TurnAllowance>()), (allowances) => ({
      charge: (callerThreadId: ThreadId, callerTurnKey: string) =>
        SynchronizedRef.modify(allowances, (current) => {
          const existing = current.get(callerThreadId);
          const used = existing !== undefined && existing.key === callerTurnKey ? existing.used : 0;
          if (used >= limit) return [false, current] as const;
          const next = new Map(current);
          next.set(callerThreadId, { key: callerTurnKey, used: used + 1 });
          return [true, next] as const;
        }),
    }));
  const createAllowance = yield* makeAllowance(LOCAL_THREAD_CREATE_PER_TURN_LIMIT);
  const wakeAllowance = yield* makeAllowance(THREAD_WAKE_PER_TURN_LIMIT);
  const targetLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());

  const lockForTarget = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(targetLocks, (current) => {
      const existing = current.get(threadId);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Effect.map(Semaphore.make(1), (semaphore) => {
        const next = new Map(current);
        next.set(threadId, semaphore);
        return [semaphore, next] as const;
      });
    });

  const resolveTurnKey = (callerThreadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(callerThreadId).pipe(
      Effect.map((thread) =>
        Option.match(thread, {
          onNone: () => "no-thread",
          onSome: (value) => value.latestTurn?.turnId ?? "no-turn",
        }),
      ),
      Effect.catchCause(() => Effect.succeed("no-turn")),
    );

  const chargeWakeAllowance = Effect.fn("ThreadService.chargeWakeAllowance")(function* (
    callerThreadId: ThreadId,
  ) {
    const turnKey = yield* resolveTurnKey(callerThreadId);
    return yield* wakeAllowance.charge(callerThreadId, turnKey);
  });

  const dispatchLocal = Effect.fn("ThreadService.dispatchLocal")(function* (
    operation: "send" | "create",
    command: ClientOrchestrationCommand,
  ) {
    return yield* orchestrationEngine
      .dispatch(command as OrchestrationCommand)
      .pipe(
        Effect.mapError(() =>
          federationFailure(
            operation,
            "message_rejected",
            "The local orchestration engine rejected this operation.",
          ),
        ),
      );
  });

  const resolveFleetNode = Effect.fn("ThreadService.resolveFleetNode")(function* (
    operation: PeerFederationOperation,
    node: ThreadNode,
  ) {
    const roster = yield* fleetRegistry.snapshot.pipe(
      Effect.mapError(() =>
        federationFailure(
          operation,
          "registry_unavailable",
          "The fleet registry is unavailable.",
          node,
        ),
      ),
    );
    const member = roster.members.find(
      (candidate) => candidate.node.name === node || candidate.node.environmentId === String(node),
    );
    if (member === undefined) {
      return yield* federationFailure(
        operation,
        "peer_not_found",
        "The target fleet node is not registered.",
        node,
      );
    }
    const resolved = yield* fleetRegistry
      .resolveByEnvironmentId(member.node.environmentId)
      .pipe(
        Effect.mapError(() =>
          federationFailure(
            operation,
            "registry_unavailable",
            "The fleet node credential is unavailable.",
            node,
          ),
        ),
      );
    if (Option.isNone(resolved)) {
      return yield* federationFailure(
        operation,
        "peer_not_found",
        "The target fleet node has no usable credential.",
        node,
      );
    }
    const endpoint =
      resolved.value.member.node.endpoints.find((candidate) => candidate.isDefault === true) ??
      resolved.value.member.node.endpoints[0];
    if (endpoint === undefined) {
      return yield* federationFailure(
        operation,
        "peer_unreachable",
        "The target fleet node has no reachable endpoint.",
        node,
      );
    }
    return {
      node: ThreadNode.make(resolved.value.member.node.name),
      baseUrl: endpoint.httpBaseUrl,
      credential: resolved.value.credential,
    } satisfies FleetThreadTarget;
  });

  const resolveLocalPlacement = Effect.fn("ThreadService.resolveLocalPlacement")(function* (
    options: ThreadServiceCreateOptions,
  ) {
    if (options.project === undefined) {
      if (options.projectId === undefined) {
        return yield* federationFailure(
          "create",
          "project_not_found",
          "Pass project or projectId to choose where the thread starts.",
        );
      }
      return {
        projectId: options.projectId,
        category: null as ProjectCategoryRecord | null,
      };
    }
    const categories = yield* projectCatalog.list.pipe(
      Effect.mapError(() =>
        federationFailure(
          "create",
          "registry_unavailable",
          "The local project catalog is unavailable.",
        ),
      ),
    );
    const category = categories.find((entry) => entry.slug === options.project);
    if (category === undefined) {
      return yield* federationFailure(
        "create",
        "project_not_found",
        "The selected project is not defined on this node.",
      );
    }
    const choice = chooseProjectLocation(category);
    if (choice.kind !== "bound") {
      return yield* federationFailure(
        "create",
        "project_not_found",
        choice.kind === "unbound"
          ? "The selected project has no folder on this node."
          : "The selected project has no unambiguous preferred folder on this node.",
      );
    }
    return { projectId: choice.projectId, category };
  });

  const remember = (threads: ReadonlyArray<ThreadSummary>) =>
    SynchronizedRef.update(locations, (current) => {
      const next = new Map(current);
      for (const thread of threads) {
        next.set(thread.threadId, { node: thread.node, local: thread.local });
      }
      return next;
    });

  const localThreads = Effect.fn("ThreadService.localThreads")(function* (
    project?: ProjectCategorySlug,
  ) {
    const [shell, categories] = yield* Effect.all(
      [projectionSnapshotQuery.getShellSnapshot(), projectCatalog.list],
      { concurrency: 2 },
    ).pipe(
      Effect.mapError(() =>
        federationFailure(
          "list",
          "registry_unavailable",
          "Local thread projection is unavailable.",
        ),
      ),
    );
    const projectByThread = peerProjectByThread({ categories, threads: shell.threads });
    return shell.threads
      .map((thread) =>
        toThreadSummary(
          summarizePeerThread(
            PeerName.make(localNode.node),
            thread,
            projectByThread.get(thread.id) ?? null,
          ),
          true,
        ),
      )
      .filter((thread) => project === undefined || thread.project === project);
  });

  const remoteThreads = Effect.fn("ThreadService.remoteThreads")(function* (options: {
    readonly node?: ThreadNode | undefined;
    readonly project?: ProjectCategorySlug | undefined;
  }) {
    const roster = yield* fleetRegistry.snapshot.pipe(
      Effect.mapError(() =>
        federationFailure("list", "registry_unavailable", "The fleet registry is unavailable."),
      ),
    );
    const targets = roster.members.filter(
      (member) =>
        member.node.environmentId !== descriptor.environmentId &&
        (options.node === undefined ||
          member.node.name === options.node ||
          member.node.environmentId === String(options.node)),
    );
    if (targets.length === 0 && options.node !== undefined) {
      return yield* federationFailure(
        "list",
        "peer_not_found",
        "The requested fleet node is not registered.",
        options.node,
      );
    }
    const results = yield* Effect.forEach(
      targets,
      (member) =>
        Effect.gen(function* () {
          const node = ThreadNode.make(member.node.name);
          const target = yield* resolveFleetNode("list", node);
          const data = yield* Effect.all(
            {
              snapshot: fetchFleetShellSnapshot({
                baseUrl: target.baseUrl,
                credential: target.credential,
              }),
              catalog: fetchFleetProjectCatalog({
                baseUrl: target.baseUrl,
                credential: target.credential,
              }).pipe(Effect.orElseSucceed(() => undefined)),
            },
            { concurrency: 2 },
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.catchCause((cause) => Effect.fail(classifyFleetFailure("list", node, cause))),
          );
          const projectByThread =
            data.catalog === undefined
              ? undefined
              : peerProjectByThread({
                  categories: data.catalog.categories,
                  threads: data.snapshot.threads,
                });
          return {
            node,
            threads: data.snapshot.threads
              .map((thread) =>
                toThreadSummary(
                  summarizePeerThread(
                    PeerName.make(node),
                    thread,
                    projectByThread === undefined
                      ? undefined
                      : (projectByThread.get(thread.id) ?? null),
                  ),
                  false,
                ),
              )
              .filter(
                (thread) => options.project === undefined || thread.project === options.project,
              ),
          };
        }).pipe(Effect.result),
      { concurrency: 4 },
    );
    return {
      threads: results.flatMap((result) =>
        result._tag === "Success" ? result.success.threads : [],
      ),
      nodesQueried: targets.map((member) => ThreadNode.make(member.node.name)),
      failures: results.flatMap((result, index): ReadonlyArray<ThreadQueryFailure> => {
        if (result._tag === "Success") return [];
        const member = targets[index];
        return [
          {
            node: ThreadNode.make(member?.node.name ?? "fleet"),
            reason: safeFederationDetail(result.failure.reason),
          },
        ];
      }),
    };
  });

  const listThreads: ThreadServiceShape["listThreads"] = Effect.fn("ThreadService.listThreads")(
    function* (options) {
      const order = options.order ?? "activity";
      if (options.cursor !== undefined && order !== "created") {
        return yield* federationFailure(
          "list",
          "cursor_requires_created_order",
          "Pass order=created when using a cursor.",
        );
      }
      const fleetIndex = yield* fleetThreadIndex.snapshot;
      const indexedLocalName =
        fleetIndex.entries.find((entry) => entry.node === descriptor.environmentId)?.nodeName ??
        localNode.node;
      const includeLocal =
        isLocalNode(options.node) ||
        (options.node !== undefined && options.node === indexedLocalName);
      const includeRemote = options.node === undefined || !includeLocal;
      const useCompatibilityFallback = includeRemote && fleetIndex.revision === 0;
      const [localResult, compatibilityResult] = yield* Effect.all(
        [
          includeLocal
            ? localThreads(options.project).pipe(
                Effect.map((threads) =>
                  threads.map((thread) => ({
                    ...thread,
                    node: ThreadNode.make(indexedLocalName),
                  })),
                ),
                Effect.result,
              )
            : Effect.succeed({ _tag: "Success", success: [] } as const),
          useCompatibilityFallback
            ? remoteThreads({
                ...(options.node === undefined ? {} : { node: options.node }),
                ...(options.project === undefined ? {} : { project: options.project }),
              }).pipe(Effect.result)
            : Effect.succeed({
                _tag: "Success",
                success: { threads: [], nodesQueried: [], failures: [] },
              } as const),
        ],
        { concurrency: 2 },
      );

      const local =
        localResult._tag === "Success" ? localResult.success : ([] as ReadonlyArray<ThreadSummary>);
      if (compatibilityResult._tag === "Failure" && options.node !== undefined) {
        return yield* sanitizeFederationError(compatibilityResult.failure);
      }
      const indexedRemoteEntries = fleetIndex.entries.filter(
        (entry) =>
          entry.node !== descriptor.environmentId &&
          (options.node === undefined || entry.nodeName === options.node) &&
          (options.project === undefined || entry.project === options.project),
      );
      const indexedRemoteFailures = fleetIndex.failures.filter(
        (failure) => options.node === undefined || failure.nodeName === options.node,
      );
      const remote = useCompatibilityFallback
        ? compatibilityResult._tag === "Success"
          ? compatibilityResult.success
          : { threads: [], nodesQueried: [], failures: [] }
        : {
            threads: indexedRemoteEntries.map((entry) => indexedThreadSummary(entry, false)),
            nodesQueried: [
              ...new Set([
                ...indexedRemoteEntries.map((entry) => ThreadNode.make(entry.nodeName)),
                ...indexedRemoteFailures.map((failure) => ThreadNode.make(failure.nodeName)),
              ]),
            ],
            failures: indexedRemoteFailures.map(
              (failure): ThreadQueryFailure => ({
                node: ThreadNode.make(failure.nodeName),
                reason: fleetFailureReason(failure),
              }),
            ),
          };
      const failures: ReadonlyArray<ThreadQueryFailure> = [
        ...(localResult._tag === "Failure"
          ? [
              {
                node: ThreadNode.make(indexedLocalName),
                reason: "Local thread index is unavailable.",
              },
            ]
          : []),
        ...remote.failures,
        ...(compatibilityResult._tag === "Failure"
          ? [{ node: ThreadNode.make("fleet"), reason: "Fleet thread index is unavailable." }]
          : []),
      ];
      const merged = [...local, ...remote.threads].toSorted(
        order === "created"
          ? (left, right) =>
              comparePeerThreadsByCreation(
                { ...left, peer: PeerName.make(left.node) },
                { ...right, peer: PeerName.make(right.node) },
              )
          : (left, right) =>
              comparePeerThreadsByActivity(
                { ...left, peer: PeerName.make(left.node) },
                { ...right, peer: PeerName.make(right.node) },
              ),
      );
      const eligible =
        options.cursor === undefined
          ? merged
          : (() => {
              const eligibleIds = new Set(
                applyPeerThreadCursor(
                  merged.map((thread) => ({ ...thread, peer: PeerName.make(thread.node) })),
                  options.cursor,
                ).map((thread) => thread.threadId),
              );
              return merged.filter((thread) => eligibleIds.has(thread.threadId));
            })();
      const limit = clampLimit(options.limit, THREADS_LIST_DEFAULT, THREADS_LIST_MAX);
      const page = eligible.slice(0, limit);
      const last = page.at(-1);
      if (
        options.node === undefined &&
        options.project === undefined &&
        options.cursor === undefined
      ) {
        yield* SynchronizedRef.set(
          locations,
          new Map(
            merged.map(
              (thread) =>
                [
                  thread.threadId,
                  { node: thread.node, local: thread.local } satisfies ThreadLocation,
                ] as const,
            ),
          ),
        );
      } else {
        yield* remember(merged);
      }
      return {
        threads: page,
        totalAvailable: eligible.length,
        nodesQueried: [
          ...new Set([
            ...(includeLocal ? [ThreadNode.make(indexedLocalName)] : []),
            ...remote.nodesQueried,
          ]),
        ],
        failures,
        order,
        nextCursor:
          order === "created" && last !== undefined && eligible.length > page.length
            ? { createdAt: last.createdAt, threadId: last.threadId }
            : null,
      } satisfies ThreadsListResult;
    },
  );

  const locateThread = Effect.fn("ThreadService.locateThread")(function* (threadId: ThreadId) {
    const local = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(
        Effect.mapError(() =>
          federationFailure("read", "registry_unavailable", "Local thread lookup is unavailable."),
        ),
      );
    if (Option.isSome(local)) {
      const location = { node: localNode.node, local: true } satisfies ThreadLocation;
      yield* remember([
        {
          node: localNode.node,
          local: true,
          threadId,
          title: local.value.title,
          provider: null,
          model: null,
          status: resolvePeerThreadStatus(local.value),
          lastActivityAt: local.value.updatedAt,
          createdAt: local.value.createdAt,
          branch: local.value.branch,
        },
      ]);
      return location;
    }
    const fleetLocation = yield* fleetThreadIndex.lookup(threadId);
    if (Option.isSome(fleetLocation) && !fleetLocation.value.local) {
      return {
        node: ThreadNode.make(fleetLocation.value.node),
        local: false,
      } satisfies ThreadLocation;
    }
    const cached = yield* SynchronizedRef.get(locations).pipe(
      Effect.map((index) => index.get(threadId)),
    );
    if (cached !== undefined) return cached;

    const roster = yield* fleetRegistry.snapshot.pipe(
      Effect.mapError(() =>
        federationFailure("read", "registry_unavailable", "Fleet node lookup is unavailable."),
      ),
    );
    for (const member of roster.members) {
      if (member.node.environmentId === descriptor.environmentId) continue;
      const node = ThreadNode.make(member.node.name);
      const result = yield* Effect.gen(function* () {
        const target = yield* resolveFleetNode("read", node);
        return yield* fetchFleetShellSnapshot({
          baseUrl: target.baseUrl,
          credential: target.credential,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) => Effect.fail(classifyFleetFailure("read", node, cause))),
        );
      }).pipe(Effect.result);
      if (result._tag === "Failure") continue;
      const found = result.success.threads.find((thread) => thread.id === threadId);
      if (found !== undefined) {
        const summary = toThreadSummary(
          summarizePeerThread(PeerName.make(node), found, undefined),
          false,
        );
        yield* remember([summary]);
        return { node: summary.node, local: false } satisfies ThreadLocation;
      }
    }
    return yield* federationFailure(
      "read",
      "thread_not_found",
      `No fleet node reported '${threadId}'.`,
    );
  });

  const readThread: ThreadServiceShape["readThread"] = Effect.fn("ThreadService.readThread")(
    function* (options) {
      const location = yield* locateThread(options.threadId);
      if (!location.local) {
        const target = yield* resolveFleetNode("read", location.node);
        const snapshot = yield* fetchFleetThreadSnapshot({
          baseUrl: target.baseUrl,
          credential: target.credential,
          threadId: options.threadId,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.fail(classifyFleetFailure("read", target.node, cause)),
          ),
        );
        const thread = snapshot.thread;
        const limit = clampLimit(
          options.limit,
          THREAD_READ_DEFAULT_ENTRIES,
          THREAD_READ_MAX_ENTRIES,
        );
        const page = renderPeerTranscript(thread, {
          limit,
          ...(options.before === undefined ? {} : { before: options.before }),
        });
        return {
          node: target.node,
          local: false,
          threadId: thread.id,
          title: thread.title,
          status: resolvePeerThreadStatus({
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            latestTurn: thread.latestTurn,
            session: thread.session,
            archivedAt: thread.archivedAt,
          }),
          provider: thread.session?.providerName ?? thread.modelSelection.instanceId ?? null,
          ...page,
        };
      }
      const [detail, shell] = yield* Effect.all(
        [
          projectionSnapshotQuery.getThreadDetailById(options.threadId),
          projectionSnapshotQuery.getThreadShellById(options.threadId),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(() =>
          federationFailure(
            "read",
            "registry_unavailable",
            "Local thread transcript is unavailable.",
          ),
        ),
      );
      if (Option.isNone(detail)) {
        return yield* federationFailure("read", "thread_not_found");
      }
      const limit = clampLimit(options.limit, THREAD_READ_DEFAULT_ENTRIES, THREAD_READ_MAX_ENTRIES);
      const page = renderPeerTranscript(detail.value, {
        limit,
        ...(options.before === undefined ? {} : { before: options.before }),
      });
      return {
        node: localNode.node,
        local: true,
        threadId: detail.value.id,
        title: detail.value.title,
        status: Option.isSome(shell)
          ? resolvePeerThreadStatus(shell.value)
          : resolvePeerThreadStatus({
              ...detail.value,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            }),
        provider:
          detail.value.session?.providerName ?? detail.value.modelSelection.instanceId ?? null,
        ...page,
      };
    },
  );

  const deliverLocallyUnlocked = Effect.fn("ThreadService.deliverLocallyUnlocked")(
    function* (input: {
      readonly callerThreadId: ThreadId;
      readonly threadId: ThreadId;
      readonly text: string;
    }) {
      if (!(yield* chargeWakeAllowance(input.callerThreadId))) return false;
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* dispatchLocal("send", {
        type: "thread.turn.start",
        commandId: CommandId.make(`local-deliver-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
          role: "user",
          authoredBy: "agent",
          text: input.text,
          attachments: [],
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      } as ClientOrchestrationCommand);
      return true;
    },
  );

  const deliverLocally = Effect.fn("ThreadService.deliverLocally")(function* (input: {
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly text: string;
  }) {
    const lock = yield* lockForTarget(input.threadId);
    return yield* lock.withPermits(1)(deliverLocallyUnlocked(input));
  });

  const wakeRemotely = Effect.fn("ThreadService.wakeRemotely")(function* (input: {
    readonly callerThreadId: ThreadId;
    readonly target: FleetThreadTarget;
    readonly threadId: ThreadId;
    readonly text: string;
  }) {
    if (!(yield* chargeWakeAllowance(input.callerThreadId))) return false;
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    return yield* dispatchFleetCommand({
      baseUrl: input.target.baseUrl,
      credential: input.target.credential,
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make(`fleet-deliver-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
          role: "user",
          authoredBy: "agent",
          text: input.text,
          attachments: [],
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      } as ClientOrchestrationCommand,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.as(true),
      Effect.catchCause(() =>
        Effect.logWarning("Could not wake fleet thread immediately; queueing message", {
          node: input.target.node,
          threadId: input.threadId,
        }).pipe(Effect.as(false)),
      ),
    );
  });

  const sendMessage: ThreadServiceShape["sendMessage"] = Effect.fn("ThreadService.sendMessage")(
    function* (options) {
      const location = yield* locateThread(options.threadId).pipe(
        Effect.mapError((error) =>
          error.operation === "read"
            ? new PeerFederationError({
                operation: "send",
                reason: error.reason,
                ...(error.peer === undefined ? {} : { peer: error.peer }),
                detail: safeFederationDetail(error.reason),
              })
            : error,
        ),
      );
      const sentAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const envelope = renderMailboxMessage({
        message: options.message,
        origin: options.origin,
        sentAt,
      });

      if (location.local) {
        const environmentId = yield* environment.getEnvironmentId;
        yield* checkMailboxDelivery({
          threadId: options.threadId,
          origin: options.origin,
          environmentId,
          projectionSnapshotQuery,
        }).pipe(
          Effect.mapError((error) =>
            error.reason === "self_delivery"
              ? federationFailure(
                  "send",
                  "self_delivery_refused",
                  safeFederationDetail("self_delivery_refused"),
                )
              : error.reason === "thread_not_found"
                ? federationFailure(
                    "send",
                    "thread_not_found",
                    safeFederationDetail("thread_not_found"),
                  )
                : federationFailure(
                    "send",
                    "registry_unavailable",
                    safeFederationDetail("registry_unavailable"),
                  ),
          ),
        );
        const delivered =
          options.queue === true || options.origin.threadId === null
            ? false
            : yield* deliverLocally({
                callerThreadId: options.origin.threadId,
                threadId: options.threadId,
                text: envelope,
              }).pipe(
                Effect.catch(() =>
                  Effect.logWarning("Could not wake local thread; queueing message", {
                    threadId: options.threadId,
                  }).pipe(Effect.as(false)),
                ),
              );
        if (delivered) {
          return {
            node: location.node,
            local: true,
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
                ? federationFailure("send", "mailbox_full", safeFederationDetail("mailbox_full"))
                : federationFailure(
                    "send",
                    "message_rejected",
                    "The local mailbox rejected this message.",
                  ),
            ),
          );
        return {
          node: location.node,
          local: true,
          threadId: options.threadId,
          delivery: "queued",
          pending: accepted.pending,
          deliveredAt: null,
        };
      }

      const target = yield* resolveFleetNode("send", location.node);
      const delivered =
        options.queue === true || options.origin.threadId === null
          ? false
          : yield* wakeRemotely({
              callerThreadId: options.origin.threadId,
              target,
              threadId: options.threadId,
              text: envelope,
            });
      if (delivered) {
        return {
          node: target.node,
          local: false,
          threadId: options.threadId,
          delivery: "now",
          pending: 0,
          deliveredAt: sentAt,
        };
      }
      const accepted = yield* sendFleetMailboxMessage({
        baseUrl: target.baseUrl,
        credential: target.credential,
        threadId: options.threadId,
        payload: { message: options.message, origin: options.origin, sentAt },
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catchCause((cause) => Effect.fail(classifyFleetFailure("send", target.node, cause))),
      );
      return {
        node: target.node,
        local: false,
        threadId: options.threadId,
        delivery: "queued",
        pending: accepted.pending,
        deliveredAt: null,
      };
    },
  );

  const createThread: ThreadServiceShape["createThread"] = Effect.fn("ThreadService.createThread")(
    function* (options) {
      if (isLocalNode(options.node)) {
        const turnKey = yield* resolveTurnKey(options.callerThreadId);
        if (!(yield* createAllowance.charge(options.callerThreadId, turnKey))) {
          return yield* federationFailure(
            "create",
            "message_rejected",
            `A thread may create at most ${LOCAL_THREAD_CREATE_PER_TURN_LIMIT} threads per turn.`,
          );
        }
        const placement = yield* resolveLocalPlacement(options);
        const project = yield* projectionSnapshotQuery
          .getProjectShellById(placement.projectId)
          .pipe(
            Effect.mapError(() =>
              federationFailure(
                "create",
                "registry_unavailable",
                "The local project projection is unavailable.",
              ),
            ),
          );
        if (Option.isNone(project)) {
          return yield* federationFailure(
            "create",
            "project_not_found",
            "The selected project folder is unavailable on this node.",
          );
        }
        const overrides = {
          instanceId: options.instanceId,
          model: options.model,
          runtimeMode: options.runtimeMode,
          interactionMode: options.interactionMode,
        };
        const modelSelection: ModelSelection | null = resolveThreadModelSelection({
          locationDefault: project.value.defaultModelSelection,
          categoryDefault: placement.category?.local.defaults.modelSelection,
          overrides,
        });
        if (modelSelection === null) {
          return yield* federationFailure(
            "create",
            "message_rejected",
            "The selected project has no usable default model.",
          );
        }
        const { runtimeMode, interactionMode } = resolveThreadModes({
          ...(placement.category === null ? {} : { category: placement.category }),
          overrides,
        });
        const threadId = ThreadId.make(`thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
        const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* dispatchLocal("create", {
          type: "thread.create",
          commandId: CommandId.make(
            `local-create-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId,
          projectId: placement.projectId,
          title: options.title,
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        } as ClientOrchestrationCommand);
        yield* dispatchLocal("create", {
          type: "thread.turn.start",
          commandId: CommandId.make(
            `local-first-turn-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId,
          message: {
            messageId: MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
            role: "user",
            text: options.message,
            attachments: [],
          },
          runtimeMode,
          interactionMode,
          createdAt,
        } as ClientOrchestrationCommand);
        const created = {
          node: localNode.node,
          local: true,
          threadId,
          projectId: placement.projectId,
          title: options.title,
        } satisfies ThreadServiceCreateResult;
        yield* SynchronizedRef.update(locations, (current) => {
          const next = new Map(current);
          next.set(created.threadId, { node: created.node, local: true });
          return next;
        });
        return created;
      }
      const node = options.node;
      if (node === undefined) {
        return yield* federationFailure("create", "peer_not_found", "No target node was selected.");
      }
      const target = yield* resolveFleetNode("create", node);
      const snapshot = yield* fetchFleetShellSnapshot({
        baseUrl: target.baseUrl,
        credential: target.credential,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catchCause((cause) =>
          Effect.fail(classifyFleetFailure("create", target.node, cause)),
        ),
      );
      const placement =
        options.project === undefined
          ? null
          : yield* Effect.gen(function* () {
              const catalog = yield* fetchFleetProjectCatalog({
                baseUrl: target.baseUrl,
                credential: target.credential,
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.catchCause((cause) =>
                  Effect.fail(classifyFleetFailure("create", target.node, cause)),
                ),
              );
              const category = catalog.categories.find((entry) => entry.slug === options.project);
              if (category === undefined) {
                return yield* federationFailure(
                  "create",
                  "project_not_found",
                  "The selected project is not defined on the target node.",
                  target.node,
                );
              }
              const choice = chooseProjectLocation(category);
              if (choice.kind !== "bound") {
                return yield* federationFailure(
                  "create",
                  "project_not_found",
                  choice.kind === "unbound"
                    ? "The selected project has no folder on the target node."
                    : "The selected project has no unambiguous preferred folder on the target node.",
                  target.node,
                );
              }
              return { projectId: choice.projectId, category };
            });
      const projectId = placement?.projectId ?? options.projectId;
      if (projectId === undefined) {
        return yield* federationFailure(
          "create",
          "project_not_found",
          "Pass project or projectId to choose where the thread starts.",
          target.node,
        );
      }
      const project = snapshot.projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) {
        return yield* federationFailure(
          "create",
          "project_not_found",
          "The selected project folder is unavailable on the target node.",
          target.node,
        );
      }
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
        return yield* federationFailure(
          "create",
          "message_rejected",
          "The selected project has no usable default model.",
          target.node,
        );
      }
      const { runtimeMode, interactionMode } = resolveThreadModes({
        ...(placement === null ? {} : { category: placement.category }),
        overrides,
      });
      const threadId = ThreadId.make(`thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const send = (command: ClientOrchestrationCommand) =>
        dispatchFleetCommand({
          baseUrl: target.baseUrl,
          credential: target.credential,
          command,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.fail(classifyFleetFailure("create", target.node, cause)),
          ),
        );
      yield* send({
        type: "thread.create",
        commandId: CommandId.make(`fleet-create-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
        threadId,
        projectId,
        title: options.title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: null,
        createdAt,
      } as ClientOrchestrationCommand);
      yield* send({
        type: "thread.turn.start",
        commandId: CommandId.make(
          `fleet-first-turn-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        threadId,
        message: {
          messageId: MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
          role: "user",
          text: options.message,
          attachments: [],
        },
        runtimeMode,
        interactionMode,
        createdAt,
      } as ClientOrchestrationCommand);
      const created = {
        node: target.node,
        local: false,
        threadId,
        projectId,
        title: options.title,
      } satisfies ThreadServiceCreateResult;
      yield* SynchronizedRef.update(locations, (current) => {
        const next = new Map(current);
        next.set(created.threadId, { node: created.node, local: false });
        return next;
      });
      return created;
    },
  );

  const getThreadDetailSnapshot: ThreadServiceShape["getThreadDetailSnapshot"] = Effect.fn(
    "ThreadService.getThreadDetailSnapshot",
  )(function* (threadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailSnapshot(threadId)
      .pipe(
        Effect.mapError(() =>
          federationFailure(
            "read",
            "registry_unavailable",
            "Local thread snapshot is unavailable.",
          ),
        ),
      );
  });

  const dispatchLifecycle = Effect.fn("ThreadService.dispatchLifecycle")(function* (
    operation: "create" | "turn" | "archive",
    command: OrchestrationCommand,
  ) {
    return yield* orchestrationEngine
      .dispatch(command)
      .pipe(Effect.mapError((cause) => new ThreadLifecycleDispatchError({ operation, cause })));
  });
  const dispatchCreate: ThreadServiceShape["dispatchCreate"] = (command) =>
    dispatchLifecycle("create", command);
  const startTurn: ThreadServiceShape["startTurn"] = (command) =>
    dispatchLifecycle("turn", command);
  const setArchived: ThreadServiceShape["setArchived"] = (command) =>
    dispatchLifecycle("archive", command);
  const refreshLocalIndex: ThreadServiceShape["refreshLocalIndex"] = Effect.gen(function* () {
    const [current, summaries] = yield* Effect.all([fleetThreadIndex.snapshot, localThreads()], {
      concurrency: 2,
    });
    const nodeName =
      current.entries.find((entry) => entry.node === descriptor.environmentId)?.nodeName ??
      FleetNodeName.make(descriptor.environmentId);
    const entries: ReadonlyArray<FleetThreadIndexEntry> = summaries.map((thread) => ({
      threadId: thread.threadId,
      node: descriptor.environmentId,
      nodeName,
      project: thread.project ?? null,
      title: thread.title,
      status: thread.status,
      lastActivityAt: thread.lastActivityAt,
      createdAt: thread.createdAt,
      provider: thread.provider,
      model: thread.model,
      branch: thread.branch,
      ...(thread.planSummary === undefined ? {} : { planSummary: thread.planSummary }),
    }));
    yield* fleetThreadIndex.replaceNodeEntries(
      entries,
      descriptor.environmentId,
      descriptor.environmentId,
    );
  });
  const refreshIndex = refreshLocalIndex;

  return ThreadService.of({
    listThreads,
    readThread,
    sendMessage,
    createThread,
    getThreadDetailSnapshot,
    dispatchCreate,
    startTurn,
    setArchived,
    refreshLocalIndex,
    refreshIndex,
  });
});

export const layer: Layer.Layer<
  ThreadService,
  never,
  | ServerEnvironment.ServerEnvironment
  | FleetThreadIndex
  | FleetRegistry
  | ProjectionSnapshotQuery
  | ProjectCatalogRegistry
  | OrchestrationEngineService
  | ThreadMailbox
  | Crypto.Crypto
  | HttpClient.HttpClient
> = Layer.effect(ThreadService, make);
