import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import { AuthSessionId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  HistoryForkRefusedError,
  HistoryForkRequest,
  HistoryForkResult,
  HistoryImportRefusedError,
  HistoryImportRequest,
  HistoryImportResult,
  HistoryImportsPage,
  HistorySessionId,
  HistorySessionsPage,
  HistoryPreview,
  HistoryTranscriptPage,
} from "./history.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
} from "./orchestration.ts";
import { PeerEnvironment, PeerRegisterInput, PeerRemoveInput, PeerRemoveResult } from "./peers.ts";
import { FeatureFlowSnapshot } from "./featureFlow.ts";
import { FeatureMapSnapshot } from "./featureMap.ts";
import {
  ProjectCatalogFileThreadRequest,
  ProjectCatalogLocationsPage,
  ProjectCatalogRemoveRequest,
  ProjectCatalogRemoveResult,
  ProjectCatalogSnapshot,
  ProjectCatalogUpsertRequest,
  ProjectCatalogUpsertResult,
} from "./projectCatalog.ts";
import {
  ThreadMailboxListResult,
  ThreadMailboxSendInput,
  ThreadMailboxSendResult,
} from "./mailbox.ts";
import {
  CliUsageModelAliasCatalog,
  CliUsageModelAliasUpdate,
  EnvironmentUsageSnapshot,
} from "./usage.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
  "invalid_peer",
  /** A thread addressed its own mailbox, or the message exceeded its bounds. */
  "invalid_mailbox_message",
  /** A filing request named no category to file into, or named one to unfile from. */
  "invalid_project_catalog_request",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_dispatch_failed",
  "usage_snapshot_failed",
  "usage_model_aliases_failed",
  "usage_model_aliases_save_failed",
  "peers_load_failed",
  "peer_registration_failed",
  "peer_remove_failed",
  "mailbox_enqueue_failed",
  "mailbox_read_failed",
  "feature_flow_failed",
  "history_sessions_failed",
  "history_preview_failed",
  "history_entries_failed",
  "history_import_failed",
  "history_imports_failed",
  "history_fork_failed",
  "project_catalog_load_failed",
  "project_catalog_save_failed",
  "project_catalog_locations_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedErrorClass<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedErrorClass<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedErrorClass<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedErrorClass<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentInternalError extends Schema.TaggedErrorClass<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals([
  "thread_not_found",
  /**
   * The id did not resolve against the server's terminal-history index. This
   * is the only answer the preview and import routes ever give for an id they
   * do not recognise, forged or merely stale, so a caller cannot distinguish a
   * file that is absent from one it is not allowed to name.
   */
  "history_session_not_found",
]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedErrorClass<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedErrorClass<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedErrorClass<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedErrorClass<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedErrorClass<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedErrorClass<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedErrorClass<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationDispatchErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@starcode/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  // A managed Cloudflare tunnel is provisioned for this link. False for a
  // publish-only link (activity publishing without a relay-managed tunnel), so
  // clients can present the two capabilities as independent settings.
  // Optional so newer clients tolerate older environment servers.
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

export class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

export class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalBearerHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OptionalBearerHeaders,
      success: OrchestrationShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OptionalBearerHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalBearerHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentOrchestrationDispatchErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentPeerMutationErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

/**
 * Peer registry administration. Reading a peer's threads happens through the
 * MCP toolkit, not here — these routes only manage which peers exist, so they
 * carry the same `access:*` scopes as the pairing-link routes they mirror.
 */
export class EnvironmentPeersHttpApi extends HttpApiGroup.make("peers")
  .add(
    HttpApiEndpoint.get("list", "/api/peers", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(PeerEnvironment),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("register", "/api/peers/register", {
      headers: OptionalBearerHeaders,
      payload: PeerRegisterInput,
      success: PeerEnvironment,
      error: EnvironmentPeerMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("remove", "/api/peers/remove", {
      headers: OptionalBearerHeaders,
      payload: PeerRemoveInput,
      success: PeerRemoveResult,
      error: EnvironmentPeerMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentMailboxParams = Schema.Struct({ threadId: ThreadId });

const EnvironmentMailboxSendErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;

/**
 * Per-thread mailbox. `send` is the one write in the fork that deliberately
 * does *not* reach the orchestration dispatch path: dispatching would start a
 * turn, and the entire point of a mailbox is that it does not. It still carries
 * `orchestration:operate`, because leaving content that a thread will later act
 * on is an operation on that thread, not a read of it.
 */
export class EnvironmentMailboxHttpApi extends HttpApiGroup.make("mailbox")
  .add(
    HttpApiEndpoint.post("send", "/api/threads/:threadId/mailbox", {
      headers: OptionalBearerHeaders,
      params: EnvironmentMailboxParams,
      payload: ThreadMailboxSendInput,
      success: ThreadMailboxSendResult,
      error: EnvironmentMailboxSendErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pending", "/api/threads/:threadId/mailbox", {
      headers: OptionalBearerHeaders,
      params: EnvironmentMailboxParams,
      success: ThreadMailboxListResult,
      error: [...EnvironmentScopedOperationErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/**
 * Feature flow. Read-scoped: every field is derived from the projection and
 * from `git` queries against repositories this server already watches, and
 * nothing here mutates.
 */
export class EnvironmentFeatureFlowHttpApi extends HttpApiGroup.make("featureFlow")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/feature-flow", {
      headers: OptionalBearerHeaders,
      success: FeatureFlowSnapshot,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * The orchestrator's own account of the same work, which the client overlays
   * on the derived snapshot above. Read-only over HTTP by design: every write
   * arrives through the master's MCP tools, so there is no route an ordinary
   * paired client could use to rewrite the map.
   */
  .add(
    HttpApiEndpoint.get("map", "/api/feature-map", {
      headers: OptionalBearerHeaders,
      success: FeatureMapSnapshot,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/**
 * Read-only usage. Gated on `orchestration:read` rather than `access:read`
 * because that is the scope a normal pairing link grants — the hub must be
 * able to read usage from every machine it is paired with, not only from the
 * one it was bootstrapped on. The cost is that an F2 peer credential can read
 * spend as well as transcripts.
 */
export class EnvironmentUsageHttpApi extends HttpApiGroup.make("usage")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/usage/snapshot", {
      headers: OptionalBearerHeaders,
      success: EnvironmentUsageSnapshot,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * The machine's model-alias registry: which unpriced models the operator has
   * declared bill like a known one, and the set of ids an alias may point at.
   *
   * Read-scoped alongside the snapshot it annotates. The catalog half is a
   * build-time constant, so this is a small response a picker can fetch once.
   */
  .add(
    HttpApiEndpoint.get("modelAliases", "/api/usage/model-aliases", {
      headers: OptionalBearerHeaders,
      success: CliUsageModelAliasCatalog,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * Replace the registry.
   *
   * `orchestration:operate` rather than `orchestration:read`, because this
   * changes what every reader of the snapshot is told a month of history cost.
   * It is deliberately *not* administrative: the registry is derived, local to
   * one machine, and reverting it is one more PUT.
   *
   * The response is the stored registry rather than an acknowledgement, so a
   * client sees exactly which rows survived validation without a second read.
   */
  .add(
    HttpApiEndpoint.put("setModelAliases", "/api/usage/model-aliases", {
      headers: OptionalBearerHeaders,
      payload: CliUsageModelAliasUpdate,
      success: CliUsageModelAliasCatalog,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/**
 * Terminal history: the CLI session logs sitting on this machine's disk,
 * outside starcode entirely.
 *
 * Import-only. There is no route here that returns a conversation — the
 * listing names sessions, the preview shows enough to tell two apart, and
 * import turns one into a thread that resumes it. Reading old history in
 * starcode is not a feature this fork has.
 *
 * Scoped on `orchestration:read` for the same reason usage is, and the same
 * reason matters more here: a remotely-paired hub client holds a pairing
 * credential, not an administrative one, and reading another machine's history
 * is the entire point of the feature.
 *
 * The listing takes its filters as query parameters rather than a POST body —
 * it is a read, it is cacheable, and its cursor belongs in a URL the client
 * can hold onto. `sessionId` is a *path* parameter everywhere else so that a
 * relay client's DPoP proof, which binds to the fully interpolated URL, covers
 * which session was asked about.
 */
export class EnvironmentHistoryHttpApi extends HttpApiGroup.make("history")
  .add(
    HttpApiEndpoint.get("sessions", "/api/history/sessions", {
      headers: OptionalBearerHeaders,
      // Every filter is an optional string parsed by the handler rather than a
      // typed schema. Query values arrive as text regardless, and a garbled
      // `limit` should clamp to something sane instead of failing the request
      // the sidebar strip made.
      query: Schema.Struct({
        since: Schema.optionalKey(Schema.String),
        until: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.String),
        cursor: Schema.optionalKey(Schema.String),
      }),
      success: HistorySessionsPage,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * Enough of a session to tell it apart from the one next to it: the opening
   * message and the last few exchanges.
   *
   * Deliberately has no query parameters. This replaced a paginated transcript
   * route, and the pagination went with it — history is import-only now, so
   * the only question left is "which conversation is this?", which a bounded
   * answer settles. Constraining the old route instead would have left a byte
   * cursor and a load-more loop behind with nothing to drive them.
   */
  .add(
    HttpApiEndpoint.get("preview", "/api/history/sessions/:sessionId/preview", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: HistorySessionId }),
      success: HistoryPreview,
      error: [...EnvironmentScopedOperationErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * A page of a session, for the one surface allowed to read one: the earlier
   * conversation behind a thread that resumed it.
   *
   * This does not reopen the history viewer. That was a destination — its own
   * route, reachable for any session on any machine — and it is still gone.
   * This is addressed the same way the preview is, but it exists to serve a
   * thread that already carries the session in its model's context, where the
   * alternative is a transcript starting mid-conversation with no way to see
   * what came before.
   *
   * Additive rather than a reshape of `preview`, deliberately. The preview is
   * two disjoint slices with no cursor, which is the right shape for telling
   * two sessions apart and the wrong one for reading a conversation; merging
   * them would have given both callers a payload with a mode flag. And an old
   * client keeps working against a new server, which a reshape would have
   * broken.
   *
   * Both parameters are optional strings parsed by the handler, matching the
   * listing: a garbled `limit` should clamp and a stale `before` should serve
   * the newest page, rather than failing a request a thread made on open.
   */
  .add(
    HttpApiEndpoint.get("entries", "/api/history/sessions/:sessionId/entries", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: HistorySessionId }),
      query: Schema.Struct({
        /** Exclusive byte ceiling; absent means the end of the session. */
        before: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.String),
      }),
      success: HistoryTranscriptPage,
      error: [...EnvironmentScopedOperationErrors, EnvironmentResourceNotFoundError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * Import: the one write on this group, and the only route in the fork that
   * reaches from a CLI's own store into t3's write model.
   *
   * `orchestration:operate` rather than `orchestration:read` because it
   * creates a thread (and possibly a project). It is a POST on the session's
   * path for the same reason the transcript route is a GET on it: a relay
   * client's DPoP proof binds to the fully interpolated URL, so which session
   * was imported is covered by the proof rather than buried in a body.
   *
   * `HistoryImportRefusedError` is separate from the generic invalid-request
   * error because its reasons are the preconditions the import checked, and a
   * dialog has to be able to say which one failed — "that session belongs to a
   * different Claude home" and "that project is rooted somewhere else" call
   * for different fixes.
   */
  .add(
    HttpApiEndpoint.post("import", "/api/history/sessions/:sessionId/import", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ sessionId: HistorySessionId }),
      payload: HistoryImportRequest,
      success: HistoryImportResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentResourceNotFoundError,
        HistoryImportRefusedError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * The import registry. Small enough to serve whole — one row per import
   * ever performed on this machine — so the picker can badge already-imported
   * sessions without asking per row.
   */
  .add(
    HttpApiEndpoint.get("imports", "/api/history/imports", {
      headers: OptionalBearerHeaders,
      success: HistoryImportsPage,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * Fork: import's mirror image, and the reason it lives in this group.
   *
   * Import binds a new thread to a session a CLI left on disk; fork binds a new
   * thread to the session a thread here is already using. Same seam, same
   * resume binding, same refusal-rather-than-fallback discipline — reached from
   * the other side.
   *
   * Keyed by **thread id, never session id**, because the client cannot name a
   * session: `HistorySessionId` is a path hash with no reverse lookup, and
   * `OrchestrationSession` carries no native session id. The server reads the
   * source's cursor out of its own directory, which makes this the only place
   * the fork can be decided.
   *
   * `orchestration:operate`, and a POST on the source thread's path for the
   * same reason import is a POST on the session's: a relay client's DPoP proof
   * binds to the fully interpolated URL, so *which thread was forked* is
   * covered by the proof rather than buried in a body.
   */
  .add(
    HttpApiEndpoint.post("fork", "/api/history/threads/:threadId/fork", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ threadId: ThreadId }),
      payload: HistoryForkRequest,
      success: HistoryForkResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentResourceNotFoundError,
        HistoryForkRefusedError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/**
 * Fork-owned: the project catalog — this machine's half of the cross-machine
 * category layer.
 *
 * Read is `orchestration:read` and every write is `orchestration:operate`, the
 * same pair history uses, and for the same reason: a paired hub client holds a
 * pairing credential and reading another machine's catalog is the entire point,
 * while creating a category on four machines at once is an operator action.
 *
 * The routes are POSTs on fixed paths rather than a REST resource with the slug
 * in the URL. The slug travels in the body so a relay client's DPoP proof — which
 * binds to the fully interpolated URL — does not have to be recomputed per
 * category, and so a fan-out write is the same request four times over.
 */
export class EnvironmentProjectCatalogHttpApi extends HttpApiGroup.make("projectCatalog")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/project-catalog", {
      headers: OptionalBearerHeaders,
      success: ProjectCatalogSnapshot,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * This machine's bindable locations, with the repository identity a seeder
   * groups on. Read-scoped: it is a projection of `projection_projects` plus
   * the catalog's own bindings, and it exists so a caller can propose one
   * category per repository without holding a shell snapshot.
   */
  .add(
    HttpApiEndpoint.get("locations", "/api/project-catalog/locations", {
      headers: OptionalBearerHeaders,
      success: ProjectCatalogLocationsPage,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * Create-or-patch, by slug. An absent section is left alone, which is what
   * lets the client send `display` to every machine and `local` to one.
   */
  .add(
    HttpApiEndpoint.post("upsert", "/api/project-catalog/upsert", {
      headers: OptionalBearerHeaders,
      payload: ProjectCatalogUpsertRequest,
      success: ProjectCatalogUpsertResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * Drops this machine's record. Deliberately local-only in effect: removing a
   * category everywhere is the client fanning this out, and a machine that was
   * offline keeps its copy until it is asked again — visible, not silent.
   */
  .add(
    HttpApiEndpoint.post("remove", "/api/project-catalog/remove", {
      headers: OptionalBearerHeaders,
      payload: ProjectCatalogRemoveRequest,
      success: ProjectCatalogRemoveResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  /**
   * Files, excludes, or unfiles one thread. Returns the whole snapshot because
   * assigning touches every category that previously claimed the thread, and a
   * caller that had to guess which ones would be re-reading anyway.
   */
  .add(
    HttpApiEndpoint.post("fileThread", "/api/project-catalog/file-thread", {
      headers: OptionalBearerHeaders,
      payload: ProjectCatalogFileThreadRequest,
      success: ProjectCatalogSnapshot,
      // Plus invalid-request: the payload carries a mode and a nullable slug,
      // and "assign to nothing" is a 400 the schema cannot express.
      error: [EnvironmentRequestInvalidError, ...EnvironmentScopedOperationErrors],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/t3-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintCredential", "/api/connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("starcodeMintCredential", "/api/t3-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentPeersHttpApi)
  .add(EnvironmentMailboxHttpApi)
  .add(EnvironmentFeatureFlowHttpApi)
  .add(EnvironmentUsageHttpApi)
  .add(EnvironmentHistoryHttpApi)
  .add(EnvironmentProjectCatalogHttpApi)
  .add(EnvironmentConnectHttpApi) {}
