/**
 * Fleet - the durable, transitive roster shared by StarCode environments.
 *
 * The roster deliberately contains metadata only. Long-lived node credentials
 * live in each server's SecretStore and transient pairing/access credentials
 * only appear in request/response contracts.
 *
 * @module Fleet
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatform } from "./environment.ts";
import { OrchestrationThreadPlanSummary } from "./orchestration.ts";
import { ProjectCategorySlug } from "./projectCategorySlug.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const FleetNodeName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/i),
);
export type FleetNodeName = typeof FleetNodeName.Type;

/** Public metadata for one execution environment. Never contains credentials. */
export const FleetNode = Schema.Struct({
  environmentId: EnvironmentId,
  name: FleetNodeName,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  endpoints: Schema.Array(AdvertisedEndpoint),
  sshUser: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
});
export type FleetNode = typeof FleetNode.Type;

/** The roster's membership record for a live node. */
export const FleetMember = Schema.Struct({
  node: FleetNode,
  registeredAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FleetMember = typeof FleetMember.Type;

/**
 * A removal marker. Tombstones participate in the same last-writer-wins merge
 * as live members, preventing a stale peer from resurrecting a removed node.
 */
export const FleetTombstone = Schema.Struct({
  environmentId: EnvironmentId,
  removedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FleetTombstone = typeof FleetTombstone.Type;

export const FleetRoster = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeInt,
  members: Schema.Array(FleetMember),
  tombstones: Schema.Array(FleetTombstone),
});
export type FleetRoster = typeof FleetRoster.Type;

export const FleetCredentialInput = Schema.Union([
  Schema.Struct({ token: TrimmedNonEmptyString }),
  Schema.Struct({ pairingToken: TrimmedNonEmptyString }),
]);
export type FleetCredentialInput = typeof FleetCredentialInput.Type;

export const FleetRegisterInput = Schema.Struct({
  name: FleetNodeName,
  baseUrl: TrimmedNonEmptyString,
  credential: FleetCredentialInput,
  sshUser: Schema.optional(TrimmedNonEmptyString),
  /**
   * URL the new peer should use to call back to this node. It is needed when
   * the server listens on a wildcard or sits behind a tunnel.
   */
  reciprocalBaseUrl: Schema.optional(TrimmedNonEmptyString),
});
export type FleetRegisterInput = typeof FleetRegisterInput.Type;

export const FleetRegisterResult = Schema.Struct({
  node: FleetNode,
  roster: FleetRoster,
});
export type FleetRegisterResult = typeof FleetRegisterResult.Type;

export const FleetPiAccountCredential = Schema.Union([
  Schema.Struct({ type: Schema.Literal("api_key"), key: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: TrimmedNonEmptyString,
    refresh: TrimmedNonEmptyString,
    expires: Schema.Number,
    extra: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
]);
export type FleetPiAccountCredential = typeof FleetPiAccountCredential.Type;

export const FleetPiAccount = Schema.Struct({
  id: ProviderInstanceId,
  label: TrimmedNonEmptyString,
  provider: Schema.Literals(["anthropic", "openai"]),
  credential: FleetPiAccountCredential,
});
export type FleetPiAccount = typeof FleetPiAccount.Type;

export const FleetPiAccountImportInput = Schema.Struct({ accounts: Schema.Array(FleetPiAccount) });
export type FleetPiAccountImportInput = typeof FleetPiAccountImportInput.Type;
export const FleetPiAccountImportResult = Schema.Struct({ imported: NonNegativeInt });
export type FleetPiAccountImportResult = typeof FleetPiAccountImportResult.Type;

export const FleetRemoveInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type FleetRemoveInput = typeof FleetRemoveInput.Type;

export const FleetRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  roster: FleetRoster,
});
export type FleetRemoveResult = typeof FleetRemoveResult.Type;

export const FleetReconcileInput = Schema.Record(Schema.String, Schema.Never);
export type FleetReconcileInput = typeof FleetReconcileInput.Type;

export const FleetReconcileFailureReason = Schema.Literals([
  "node_unreachable",
  "authorization_failed",
  "reconcile_failed",
]);
export type FleetReconcileFailureReason = typeof FleetReconcileFailureReason.Type;

export const FleetReconcileFailure = Schema.Struct({
  environmentId: EnvironmentId,
  reason: FleetReconcileFailureReason,
});
export type FleetReconcileFailure = typeof FleetReconcileFailure.Type;

export const FleetReconcileResult = Schema.Struct({
  roster: FleetRoster,
  failures: Schema.Array(FleetReconcileFailure),
});
export type FleetReconcileResult = typeof FleetReconcileResult.Type;

/**
 * A short-lived introduction minted by a node that already knows both sides.
 * It is never written to fleet.json.
 */
export const FleetIntroduction = Schema.Struct({
  node: FleetNode,
  pairingToken: TrimmedNonEmptyString,
});
export type FleetIntroduction = typeof FleetIntroduction.Type;

export const FleetExchangeInput = Schema.Struct({
  requester: FleetMember,
  roster: FleetRoster,
  reciprocalPairingToken: TrimmedNonEmptyString,
});
export type FleetExchangeInput = typeof FleetExchangeInput.Type;

export const FleetExchangeResult = Schema.Struct({
  roster: FleetRoster,
  introductions: Schema.Array(FleetIntroduction),
});
export type FleetExchangeResult = typeof FleetExchangeResult.Type;

export const FleetThreadStatus = Schema.Literals([
  "approval",
  "input",
  "working",
  "failed",
  "archived",
  "idle",
]);
export type FleetThreadStatus = typeof FleetThreadStatus.Type;

/** Routing/index metadata only; transcript content remains on the owning node. */
export const FleetThreadIndexEntry = Schema.Struct({
  threadId: ThreadId,
  node: EnvironmentId,
  nodeName: FleetNodeName,
  project: Schema.NullOr(ProjectCategorySlug),
  title: TrimmedNonEmptyString,
  status: FleetThreadStatus,
  lastActivityAt: IsoDateTime,
  createdAt: IsoDateTime,
  provider: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  planSummary: Schema.optionalKey(Schema.NullOr(OrchestrationThreadPlanSummary)),
});
export type FleetThreadIndexEntry = typeof FleetThreadIndexEntry.Type;

export const FleetThreadIndexFailure = Schema.Struct({
  node: EnvironmentId,
  nodeName: FleetNodeName,
  reason: Schema.Literals(["unreachable", "unauthorized", "unavailable"]),
});
export type FleetThreadIndexFailure = typeof FleetThreadIndexFailure.Type;

export const FleetThreadIndex = Schema.Struct({
  revision: NonNegativeInt,
  entries: Schema.Array(FleetThreadIndexEntry),
  failures: Schema.Array(FleetThreadIndexFailure),
});
export type FleetThreadIndex = typeof FleetThreadIndex.Type;

/**
 * Process-memory connection material for a viewer. These credentials are
 * ordinary client sessions, never the administrative credentials used between
 * fleet nodes and never persisted in the roster.
 */
export const FleetClientBootstrapNode = Schema.Struct({
  nodeId: FleetNodeName,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  endpoint: Schema.Struct({
    httpBaseUrl: TrimmedNonEmptyString,
    wsBaseUrl: TrimmedNonEmptyString,
  }),
  credential: Schema.Struct({
    bearerToken: TrimmedNonEmptyString,
    expiresAtEpochMs: Schema.optional(NonNegativeInt),
  }),
});
export type FleetClientBootstrapNode = typeof FleetClientBootstrapNode.Type;

export const FleetClientBootstrapResult = Schema.Struct({
  revision: NonNegativeInt,
  nodes: Schema.Array(FleetClientBootstrapNode),
});
export type FleetClientBootstrapResult = typeof FleetClientBootstrapResult.Type;
