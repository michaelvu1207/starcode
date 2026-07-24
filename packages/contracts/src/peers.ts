/**
 * Peers - cross-machine thread federation contracts.
 *
 * A peer is another t3 environment this environment holds a credential for.
 * Peers are registered by redeeming a pairing token minted on the peer, and the
 * credential is narrowed to `orchestration:read` during the token exchange, so
 * federation can only ever read: it can never dispatch on a peer.
 *
 * @module Peers
 */
import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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
 * A registered peer as exposed over HTTP. The stored bearer credential is
 * deliberately absent: it lives in the server secret store and is never
 * returned by any route.
 */
export const PeerEnvironment = Schema.Struct({
  name: PeerName,
  baseUrl: PeerBaseUrl,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.NullOr(TrimmedNonEmptyString),
  scopes: AuthEnvironmentScopes,
  registeredAt: IsoDateTime,
  credentialExpiresAt: IsoDateTime,
});
export type PeerEnvironment = typeof PeerEnvironment.Type;

export const PeerRegisterInput = Schema.Struct({
  name: PeerName,
  baseUrl: PeerBaseUrl,
  /** A single-use pairing token minted on the peer with `orchestration:read`. */
  pairingToken: TrimmedNonEmptyString,
});
export type PeerRegisterInput = typeof PeerRegisterInput.Type;

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
  branch: Schema.NullOr(TrimmedNonEmptyString),
});
export type PeerThreadSummary = typeof PeerThreadSummary.Type;

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
      description: `Maximum threads to return, most recently active first. Defaults to ${PEER_THREADS_LIST_DEFAULT}.`,
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

export const PeerFederationOperation = Schema.Literals(["list", "read"]);
export type PeerFederationOperation = typeof PeerFederationOperation.Type;

export const PeerFederationReason = Schema.Literals([
  "no_peers_registered",
  "peer_not_found",
  "peer_unreachable",
  "peer_unauthorized",
  "thread_not_found",
  "capability_unavailable",
  "registry_unavailable",
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
