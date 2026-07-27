/**
 * PeerThreadWriter - the write half of federation.
 *
 * Three operations, deliberately unequal in what they cost the recipient:
 *
 * - `send` leaves a message in a mailbox. Free, non-interrupting, available to
 *   every session. This is the channel agents are meant to use.
 * - `dispatch` starts a turn on another thread right now. It costs money and
 *   takes the thread away from whatever it was doing, so it is master-only and
 *   reserved for start-work / stop-work.
 * - `create` makes a new thread on another machine and gives it its first
 *   instruction. Also master-only.
 *
 * `peer` is optional on `send` alone, and omitting it addresses a thread on
 * this machine. That is not a convenience shim: threads on one machine need to
 * talk to each other as much as threads across machines do, and routing the
 * local case through the registry would have meant registering a machine as its
 * own peer just to say something to the thread next to it. `dispatch` has no
 * local form on purpose — interrupting a thread on the machine the operator is
 * sitting at is theirs to do, and the UI already has a button for it.
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
  type PeerThreadDispatchResult,
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
import { checkMailboxDelivery } from "../mailbox/intake.ts";
import { ThreadMailbox } from "../mailbox/ThreadMailbox.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  dispatchPeerCommand,
  fetchPeerProjectCatalog,
  fetchPeerShellSnapshot,
  sendPeerMailboxMessage,
} from "./PeerEnvironmentClient.ts";
import { PeerRegistry, type ResolvedPeer } from "./PeerRegistry.ts";
import {
  choosePeerProjectLocation,
  resolvePeerThreadModelSelection,
  resolvePeerThreadModes,
} from "./peerProjectPlacement.ts";

export interface PeerThreadSendOptions {
  readonly peer?: PeerName | undefined;
  readonly threadId: ThreadId;
  readonly message: string;
  /** Provenance of the calling session; stamped onto the delivered envelope. */
  readonly origin: ThreadMailboxOrigin;
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

export interface PeerThreadDispatchOptions {
  readonly peer: PeerName;
  readonly threadId: ThreadId;
  readonly message: string;
}

export interface PeerThreadWriterShape {
  readonly sendMessage: (
    options: PeerThreadSendOptions,
  ) => Effect.Effect<PeerThreadSendResult, PeerFederationError>;
  readonly createThread: (
    options: PeerThreadCreateOptions,
  ) => Effect.Effect<PeerThreadCreateResult, PeerFederationError>;
  readonly dispatchThread: (
    options: PeerThreadDispatchOptions,
  ) => Effect.Effect<PeerThreadDispatchResult, PeerFederationError>;
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
    return failure(
      operation,
      "peer_unauthorized",
      peer,
      "Peer rejected this environment's credential; re-register the peer with the operate class.",
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

export const make = Effect.gen(function* () {
  const registry = yield* PeerRegistry;
  const httpClient = yield* HttpClient.HttpClient;
  const mailbox = yield* ThreadMailbox;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

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

  const sendMessage: PeerThreadWriterShape["sendMessage"] = Effect.fn(
    "PeerThreadWriter.sendMessage",
  )(function* (options) {
    const sentAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

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
        pending: accepted.pending,
        deliveredAt: null,
      };
    }

    const { peer, credential } = yield* resolveOperablePeer("send", options.peer);
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
            const choice = choosePeerProjectLocation(category);
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
    const modelSelection = resolvePeerThreadModelSelection({
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
    const { runtimeMode, interactionMode } = resolvePeerThreadModes({
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
    // `bootstrap.createThread` block. The bootstrap form exists, and the
    // schema accepts it over HTTP, but only the WebSocket handler ever unpacks
    // it — the HTTP endpoint hands the command straight to the engine, whose
    // decider then rejects a turn on a thread that does not exist yet. So the
    // thread is created first and told what to do second.
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

  const dispatchThread: PeerThreadWriterShape["dispatchThread"] = Effect.fn(
    "PeerThreadWriter.dispatchThread",
  )(function* (options) {
    const { peer, credential } = yield* resolveOperablePeer("dispatch", options.peer);
    const commandId = CommandId.make(
      `peer-dispatch-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    );
    const messageId = MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    // Plain `thread.turn.start` against an existing thread — exactly what the
    // operator's own composer sends. The interrupt semantics are the peer's,
    // not something this fork reimplements.
    //
    // The modes here are schema ballast, not a decision: the peer's decider
    // reads the *thread's* stored modes for the turn it starts and ignores
    // these two fields (`decider.ts`, `thread.turn.start`). They still have to
    // decode, so they carry the app-wide defaults rather than a stricter pair
    // that would read as an intent this call does not have.
    const command = {
      type: "thread.turn.start",
      commandId,
      threadId: options.threadId,
      message: { messageId, role: "user", text: options.message, attachments: [] },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt,
    } as unknown as ClientOrchestrationCommand;

    yield* dispatchPeerCommand({ baseUrl: peer.baseUrl, credential, command }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.catchCause((cause) =>
        Effect.fail(classifyPeerFailure("dispatch", peer.name, cause as Cause.Cause<unknown>)),
      ),
    );

    return { peer: peer.name, threadId: options.threadId, dispatched: true };
  });

  return { sendMessage, createThread, dispatchThread } satisfies PeerThreadWriterShape;
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
> = Layer.effect(PeerThreadWriter, make);
