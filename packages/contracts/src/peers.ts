/**
 * Peers - cross-machine thread federation contracts.
 *
 * A peer is another t3 environment this environment holds a credential for.
 * Peers are registered by redeeming a pairing token minted on the peer, and the
 * credential is narrowed during the token exchange to exactly what its class
 * allows.
 *
 * There are two classes, and the class is a property of the stored credential
 * rather than of the call site, so what a peer entry can do is answerable by
 * looking at the registry instead of by auditing every caller. A `read` peer
 * carries `orchestration:read` and can only ever be read from. An `operate`
 * peer additionally carries `orchestration:operate`, which is what lets this
 * environment create threads on the peer and deliver messages to the ones
 * already running there. Registration refuses anything broader than its class requires, so a
 * mis-issued administrative token cannot quietly become a federation credential.
 *
 * @module Peers
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MAILBOX_MESSAGE_MAX_CHARS } from "./mailbox.ts";
import {
  ModelSelection,
  OrchestrationThreadPlanSummary,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ProjectCategorySlug } from "./projectCategorySlug.ts";

/** Upper bound on transcript entries a single `peer_thread_read` may return. */
export const PEER_THREAD_READ_MAX_ENTRIES = 100;
/** Entries returned when `peer_thread_read` is called without an explicit limit. */
export const PEER_THREAD_READ_DEFAULT_ENTRIES = 30;
/** Upper bound on threads a single `peer_threads_list` may return. */
export const PEER_THREADS_LIST_MAX = 200;
/** Threads returned when `peer_threads_list` is called without an explicit limit. */
export const PEER_THREADS_LIST_DEFAULT = 50;
/** Per-entry message text budget before the transcript renderer truncates. */
export const PEER_TRANSCRIPT_ENTRY_MAX_CHARS = 4_000;
/** Per-entry tool-call name budget; tool payloads are never rendered at all. */
export const PEER_TRANSCRIPT_MAX_TOOL_CALLS = 12;

export const PeerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/i),
);
export type PeerName = typeof PeerName.Type;

export const PeerBaseUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
export type PeerBaseUrl = typeof PeerBaseUrl.Type;

/**
 * What a peer credential is allowed to do. `read` is the F2 default and the
 * only class that existed before operator federation, which is why it is the
 * decoding default: a `peers.json` written by an older server has no
 * `credentialClass` field and must keep meaning read-only.
 */
export const PeerCredentialClass = Schema.Literals(["read", "operate"]);
export type PeerCredentialClass = typeof PeerCredentialClass.Type;

/**
 * A registered peer as exposed over HTTP. The stored bearer credential is
 * deliberately absent: it lives in the server secret store and is never
 * returned by any route. `credentialClass` and `scopes` are both present on
 * purpose — the class is the intent, the scopes are what the peer actually
 * granted, and a reader should be able to see them disagree.
 */
export const PeerEnvironment = Schema.Struct({
  name: PeerName,
  baseUrl: PeerBaseUrl,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.NullOr(TrimmedNonEmptyString),
  credentialClass: PeerCredentialClass.pipe(
    Schema.withDecodingDefault(Effect.succeed("read" as const satisfies PeerCredentialClass)),
  ),
  /**
   * Login name for reaching this machine over SSH, or null when nobody has
   * recorded one. Only the user: the host is already in `baseUrl`, and the key
   * is assumed to be installed, so a username is the whole of what an agent is
   * missing to run `ssh <user>@<host>`.
   *
   * A decoding default of null on purpose — every `peers.json` written before
   * this field existed omits it, and those files must keep loading rather than
   * failing the whole registry over an absent key. This is deliberately not a
   * credential: no secret is stored here and nothing reads it but a human or an
   * agent deciding how to reach a box.
   */
  sshUser: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  scopes: AuthEnvironmentScopes,
  registeredAt: IsoDateTime,
  credentialExpiresAt: IsoDateTime,
});
export type PeerEnvironment = typeof PeerEnvironment.Type;

/**
 * Two ways to hand this environment a peer credential.
 *
 * `token` is the v1 path for a small fixed fleet: run
 * `t3 auth session issue --token-only --read-only` on the peer and paste the
 * result. Nothing is redeemed — the token is verified against the peer's own
 * session endpoint and stored.
 *
 * `pairingToken` is the browser/one-time path: a single-use pairing credential
 * is redeemed through the existing RFC 8693 exchange, which narrows the
 * resulting bearer to `orchestration:read`.
 *
 * Either way the stored credential must end up read-only; the difference is
 * only who narrowed it — the CLI flag, or the exchange.
 */
export const PeerCredentialInput = Schema.Union([
  Schema.Struct({ token: TrimmedNonEmptyString }),
  Schema.Struct({ pairingToken: TrimmedNonEmptyString }),
]);
export type PeerCredentialInput = typeof PeerCredentialInput.Type;

export const PeerRegisterInput = Schema.Struct({
  name: PeerName,
  baseUrl: PeerBaseUrl,
  credential: PeerCredentialInput,
  /**
   * Optional so an F2-era caller keeps registering read-only peers unchanged.
   * Asking for `operate` is an explicit act: it widens what this environment
   * can do to another machine, and the peer still has to have granted the
   * scope for the registration to succeed.
   */
  credentialClass: Schema.optional(PeerCredentialClass),
  /** Login name for `ssh <user>@<host>`. Absent leaves the peer's login unknown. */
  sshUser: Schema.optional(TrimmedNonEmptyString),
});
export type PeerRegisterInput = typeof PeerRegisterInput.Type;

/**
 * How to reach one registered connection, as an agent sees it.
 *
 * This exists because every other federation tool takes a peer *name* as input
 * and none of them would tell you what names there are — the fleet layout was
 * only discoverable by reading `peers.json` off disk, which an agent on another
 * machine cannot do.
 *
 * `sshHost` is split out of `baseUrl` rather than left for the caller to parse:
 * the whole point is that `sshUser` + `sshHost` compose into a command without
 * the agent writing a URL parser, and a peer registered with a hostname rather
 * than an address should still yield the right thing.
 */
export const PeerConnectionSummary = Schema.Struct({
  name: PeerName,
  label: Schema.NullOr(TrimmedNonEmptyString),
  baseUrl: PeerBaseUrl,
  /** Host from `baseUrl`, ready to pair with `sshUser`. Null if it cannot be parsed. */
  sshHost: Schema.NullOr(TrimmedNonEmptyString),
  sshUser: Schema.NullOr(TrimmedNonEmptyString),
  credentialClass: PeerCredentialClass,
  environmentId: Schema.NullOr(EnvironmentId),
});
export type PeerConnectionSummary = typeof PeerConnectionSummary.Type;

export const PeersListInput = Schema.Struct({});
export type PeersListInput = typeof PeersListInput.Type;

export const PeersListResult = Schema.Struct({
  connections: Schema.Array(PeerConnectionSummary),
});
export type PeersListResult = typeof PeersListResult.Type;

export const PeerRemoveInput = Schema.Struct({
  name: PeerName,
});
export type PeerRemoveInput = typeof PeerRemoveInput.Type;

export const PeerRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type PeerRemoveResult = typeof PeerRemoveResult.Type;

/**
 * Coarse thread state derived from the peer's shell snapshot. Intentionally
 * narrower than the client's sidebar classification: it only uses fields the
 * shell snapshot itself carries, so it cannot drift with client-side settle or
 * snooze policy.
 */
export const PeerThreadStatus = Schema.Literals([
  "approval",
  "input",
  "working",
  "failed",
  "archived",
  "settled",
  "idle",
]);
export type PeerThreadStatus = typeof PeerThreadStatus.Type;

export const PeerThreadSummary = Schema.Struct({
  peer: PeerName,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  provider: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  status: PeerThreadStatus,
  lastActivityAt: IsoDateTime,
  createdAt: IsoDateTime,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Task progress as the thread itself reports it, so an orchestrating agent
   * can see how far a child task has got without reading the transcript.
   * `optionalKey` rather than nullable: a peer running a server from before
   * plan summaries existed omits the key entirely, and "the peer cannot tell
   * me" must stay distinguishable from "the thread has no plan".
   */
  planSummary: Schema.optionalKey(Schema.NullOr(OrchestrationThreadPlanSummary)),
  /**
   * Which project the thread belongs to, by slug — the name that is the same
   * word on every machine. The peer's own `projectId` is deliberately not
   * carried: it names a folder on that machine and means nothing here.
   *
   * `optionalKey` over a nullable for the same reason `planSummary` is. An
   * absent key means the peer could not tell us — either it runs a server from
   * before this field, or its project catalog was unreachable while its threads
   * were not. `null` means the thread genuinely sits under no project. Collapse
   * those two and a project filter silently drops every thread on a machine
   * that has not been upgraded yet, which reads as "nobody else is working on
   * this" — the most dangerous wrong answer this tool can give.
   */
  project: Schema.optionalKey(Schema.NullOr(ProjectCategorySlug)),
});
export type PeerThreadSummary = typeof PeerThreadSummary.Type;

/**
 * The fork's thread-list cursor convention. `(createdAt, threadId)` is chosen
 * to match `idx_projection_threads_shell_active`, so if list paging is ever
 * pushed down to SQL the cursor already lines up with the supporting index.
 *
 * It deliberately does not key on activity: there is no `last_activity_at`
 * column — activity is a fold over four fields across two projections — so an
 * activity-keyed cursor could never be satisfied by an index scan.
 */
export const PeerThreadCursor = Schema.Struct({
  createdAt: IsoDateTime,
  threadId: ThreadId,
});
export type PeerThreadCursor = typeof PeerThreadCursor.Type;

/**
 * `activity` ranks the most recently active threads first and is what an agent
 * asking "what is running elsewhere" wants; it is a ranked head, bounded by
 * `limit`. `created` is newest-first by creation and is the only order a
 * cursor can traverse deterministically.
 */
export const PeerThreadsOrder = Schema.Literals(["activity", "created"]);
export type PeerThreadsOrder = typeof PeerThreadsOrder.Type;

/**
 * One peer that could not be reached. Reported alongside successful results so
 * a single unreachable machine never fails the whole listing.
 */
export const PeerQueryFailure = Schema.Struct({
  peer: PeerName,
  reason: TrimmedNonEmptyString,
});
export type PeerQueryFailure = typeof PeerQueryFailure.Type;

export const PeerThreadsListResult = Schema.Struct({
  threads: Schema.Array(PeerThreadSummary),
  /** Threads matched across all queried peers before `limit` was applied. */
  totalAvailable: NonNegativeInt,
  peersQueried: Schema.Array(PeerName),
  failures: Schema.Array(PeerQueryFailure),
  order: PeerThreadsOrder,
  /** Pass back as `cursor` for the next page. Only set when order is `created`. */
  nextCursor: Schema.NullOr(PeerThreadCursor),
});
export type PeerThreadsListResult = typeof PeerThreadsListResult.Type;

export const PeerTranscriptEntry = Schema.Struct({
  /** Position in the full transcript; stable cursor for paging back. */
  index: NonNegativeInt,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  /** True when `text` was clipped to the per-entry budget. */
  truncated: Schema.Boolean,
  /** Tool-call names observed in this entry's turn. Payloads are never included. */
  toolCalls: Schema.Array(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type PeerTranscriptEntry = typeof PeerTranscriptEntry.Type;

export const PeerThreadReadResult = Schema.Struct({
  peer: PeerName,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  status: PeerThreadStatus,
  provider: Schema.NullOr(TrimmedNonEmptyString),
  totalEntries: NonNegativeInt,
  entries: Schema.Array(PeerTranscriptEntry),
  /** Older entries exist before the first returned entry. */
  hasMore: Schema.Boolean,
  /** Pass as `before` to fetch the page immediately older than this one. */
  nextBefore: Schema.NullOr(NonNegativeInt),
});
export type PeerThreadReadResult = typeof PeerThreadReadResult.Type;

export const PeerThreadsListInput = Schema.Struct({
  peer: Schema.optional(
    PeerName.annotate({
      description: "Restrict to one registered peer. Omit to query every peer.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(PEER_THREADS_LIST_MAX),
    ).annotate({
      description: `Maximum threads to return. Defaults to ${PEER_THREADS_LIST_DEFAULT}.`,
    }),
  ),
  order: Schema.optional(
    PeerThreadsOrder.annotate({
      description:
        "activity (default) returns the most recently active threads first. created returns newest-first by creation and is the only order that can be paged with a cursor.",
    }),
  ),
  cursor: Schema.optional(
    PeerThreadCursor.annotate({
      description:
        "Pass the previous response's nextCursor to fetch the next page. Requires order=created.",
    }),
  ),
  /**
   * Scoping is opt-out rather than opt-in, deliberately. The question an agent
   * actually has is "who else is working on my project", and answering it with
   * every thread on every machine in every project buries it. So the default is
   * the caller's own project, and the whole fleet is the thing you ask for.
   */
  project: Schema.optional(
    ProjectCategorySlug.annotate({
      description:
        "Only threads filed under this project slug, on any machine. Defaults to the calling thread's own project. Pass allProjects instead to see every project.",
    }),
  ),
  allProjects: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Set true to list threads across every project rather than just the calling thread's own. Cannot be combined with project.",
    }),
  ),
});
export type PeerThreadsListInput = typeof PeerThreadsListInput.Type;

export const PeerThreadReadInput = Schema.Struct({
  peer: PeerName.annotate({
    description: "Registered peer name, as reported by peer_threads_list.",
  }),
  threadId: ThreadId.annotate({
    description: "Thread id on that peer, as reported by peer_threads_list.",
  }),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(PEER_THREAD_READ_MAX_ENTRIES),
    ).annotate({
      description: `Transcript entries to return. Defaults to the newest ${PEER_THREAD_READ_DEFAULT_ENTRIES}.`,
    }),
  ),
  before: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Return the entries immediately older than this transcript index. Pass the previous response's nextBefore to page backwards.",
    }),
  ),
});
export type PeerThreadReadInput = typeof PeerThreadReadInput.Type;

/**
 * Message body accepted by `peer_thread_send`. Kept as its own schema so the
 * MCP tool and the HTTP route that carries it stay in step.
 *
 * The length cap is stated here as well as on `ThreadMailboxSendInput` rather
 * than only there. A message now reaches the recipient as the text of a turn
 * without necessarily passing through the mailbox at all, so a cap that lived
 * only on the queue path would bound nothing on the path most messages take.
 */
export const PeerThreadSendInput = Schema.Struct({
  peer: Schema.optional(
    PeerName.annotate({
      description:
        "Registered peer that hosts the thread. Omit to send to a thread on this machine.",
    }),
  ),
  threadId: ThreadId.annotate({
    description: "Thread to deliver to, as reported by peer_threads_list.",
  }),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(MAILBOX_MESSAGE_MAX_CHARS)).annotate({
    description:
      "Message to deliver. It reaches the thread the way a message from your operator would: an idle thread starts a turn on it, and a thread that is already working receives it as part of the turn it is running.",
  }),
  queue: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Set true to leave the message waiting instead of delivering it now. The thread picks it up whenever it next takes a turn for its own reasons, so it costs the recipient nothing and never interrupts. Use this for anything the thread does not need to act on immediately.",
    }),
  ),
});
export type PeerThreadSendInput = typeof PeerThreadSendInput.Type;

/**
 * How a send actually reached the thread.
 *
 * Reported rather than assumed because the two outcomes are genuinely different
 * to a sender: `now` means the thread is already working on it, `queued` means
 * nothing will happen until that thread turns for some other reason. A sender
 * that treats the second as the first waits forever for an answer.
 */
export const PeerThreadSendDelivery = Schema.Literals(["now", "queued"]);
export type PeerThreadSendDelivery = typeof PeerThreadSendDelivery.Type;

export const PeerThreadSendResult = Schema.Struct({
  peer: Schema.NullOr(PeerName),
  threadId: ThreadId,
  delivery: PeerThreadSendDelivery,
  /**
   * Undelivered messages waiting on the target thread, including this one.
   * Zero when the message was delivered immediately, since nothing is waiting.
   */
  pending: NonNegativeInt,
  /** When the message was handed to the thread, or null when it was queued. */
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type PeerThreadSendResult = typeof PeerThreadSendResult.Type;

export const PeerProjectSummary = Schema.Struct({
  peer: PeerName,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
});
export type PeerProjectSummary = typeof PeerProjectSummary.Type;

export const PeerThreadCreateInput = Schema.Struct({
  peer: PeerName.annotate({ description: "Registered peer to create the thread on." }),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Folder on that peer to create the thread in, by the peer's own id. Use peer_threads_list to discover them. Omit when you pass project instead.",
    }),
  ),
  /**
   * The cross-machine way to say where work goes.
   *
   * A `projectId` is one machine's id for one folder, so delegating by id means
   * the caller has to know the peer's filesystem. A slug is the same word on
   * every machine, which is what a project *is* — and because the thread lands
   * in a folder the peer already binds, the peer files it into that project on
   * its own with no cross-machine write anywhere.
   */
  project: Schema.optional(
    ProjectCategorySlug.annotate({
      description:
        "Project slug to create the thread under. The peer resolves it to whichever of its folders is bound to that project, and the new thread starts with that project's configured provider, model and modes. If the peer binds several folders and names no preferred one, the call is refused rather than guessed — pass projectId then. Use this instead of projectId when you know the project by name.",
    }),
  ),
  title: TrimmedNonEmptyString.annotate({ description: "Short name for the new thread." }),
  message: TrimmedNonEmptyString.annotate({
    description: "First message. The new thread starts a turn on it immediately.",
  }),
  instanceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Provider instance on the peer, e.g. claude or codex. Defaults to the project's configured provider.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id for the new thread. Defaults to the project's configured model.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({
      description:
        "How much the new thread may do without asking. Defaults to the project's setting on that peer, or full-access.",
    }),
  ),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description:
        "plan keeps the new thread read-only; default lets it edit. Defaults to the project's setting on that peer, or default.",
    }),
  ),
});
export type PeerThreadCreateInput = typeof PeerThreadCreateInput.Type;

export const PeerThreadCreateResult = Schema.Struct({
  peer: PeerName,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
});
export type PeerThreadCreateResult = typeof PeerThreadCreateResult.Type;

export const PeerFederationOperation = Schema.Literals(["list", "read", "send", "create"]);
export type PeerFederationOperation = typeof PeerFederationOperation.Type;

export const PeerFederationReason = Schema.Literals([
  "no_peers_registered",
  "peer_not_found",
  "peer_unreachable",
  "peer_unauthorized",
  "thread_not_found",
  "capability_unavailable",
  "registry_unavailable",
  "cursor_requires_created_order",
  /** The peer is registered read-only; writing to it needs an operate-class entry. */
  "peer_not_operable",
  /** A thread tried to send to itself. Refused structurally, not by convention. */
  "self_delivery_refused",
  /** The target thread's mailbox is at its undelivered ceiling. */
  "mailbox_full",
  "project_not_found",
  "message_rejected",
  /**
   * `project` and `allProjects` were both given. Refused rather than resolved by
   * precedence: either answer silently ignores half of what the caller asked
   * for, and a listing that quietly changed scope is one an agent would act on.
   */
  "project_scope_ambiguous",
  /**
   * The default scope is the caller's own project and the caller has none — it
   * sits under no project, or it is not a thread on this machine at all. Refused
   * rather than falling back to every project, because the fallback is the
   * fleet-wide firehose this default exists to avoid.
   */
  "caller_project_unknown",
]);
export type PeerFederationReason = typeof PeerFederationReason.Type;

export class PeerFederationError extends Schema.TaggedErrorClass<PeerFederationError>()(
  "PeerFederationError",
  {
    operation: PeerFederationOperation,
    reason: PeerFederationReason,
    peer: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const target = this.peer ? ` for peer ${this.peer}` : "";
    return `Peer ${this.operation}${target} failed: ${this.reason}.`;
  }
}
