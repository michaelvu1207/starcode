/**
 * PeerEnvironmentClient - typed HTTP access to another starcode environment.
 *
 * Every call goes through the same `EnvironmentHttpApi` contract this server
 * serves, so peer reads stay schema-checked end to end and cannot drift from
 * the routes they call. Nothing here hand-rolls a fetch or parses a payload.
 *
 * @module PeerEnvironmentClient
 */
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  type ClientOrchestrationCommand,
  EnvironmentHttpApi,
  type PeerCredentialClass,
  type ThreadId,
  type ThreadMailboxSendInput,
} from "@starcode/contracts";
import { encodeOAuthScope } from "@starcode/shared/oauthScope";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

/**
 * Bounded so one unreachable machine cannot stall a multi-peer listing (or an
 * agent's tool call) for longer than an agent is willing to wait.
 */
export const PEER_REQUEST_TIMEOUT = Duration.seconds(10);

/**
 * The exact scope set each credential class must carry — not a minimum. A
 * registration is refused both when a scope is missing and when one is extra,
 * so a peer entry's authority is exactly what its class advertises and cannot
 * be quietly widened by pasting in a broader token.
 */
export const PEER_CREDENTIAL_SCOPES_BY_CLASS = {
  read: [AuthOrchestrationReadScope],
  // Operate is additive on purpose: an operator peer still has to be readable,
  // because every write tool addresses a thread the caller found by reading.
  operate: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
} as const satisfies Record<PeerCredentialClass, ReadonlyArray<AuthEnvironmentScope>>;

/** @deprecated Read-only scope set; kept so F2 call sites keep compiling. */
export const PEER_CREDENTIAL_SCOPES = PEER_CREDENTIAL_SCOPES_BY_CLASS.read;

export const peerCredentialScopes = (
  credentialClass: PeerCredentialClass,
): ReadonlyArray<AuthEnvironmentScope> => PEER_CREDENTIAL_SCOPES_BY_CLASS[credentialClass];

export type PeerScopeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "scope_not_granted";
      readonly missing: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly reason: "scope_too_broad";
      readonly excess: ReadonlyArray<string>;
    };

/**
 * Judges what a peer says it granted against what the requested class allows.
 *
 * Exact-match rather than "at least": a credential that grants more than its
 * class needs is refused, not silently accepted and labelled read-only. Kept
 * pure so the rule can be exercised without standing up a peer.
 */
export const judgePeerScopes = (
  credentialClass: PeerCredentialClass,
  grantedScopes: ReadonlyArray<string>,
): PeerScopeVerdict => {
  const required = peerCredentialScopes(credentialClass);
  const missing = required.filter((scope) => !grantedScopes.includes(scope));
  if (missing.length > 0) return { ok: false, reason: "scope_not_granted", missing };
  const excess = grantedScopes.filter(
    (scope) => !(required as ReadonlyArray<string>).includes(scope),
  );
  if (excess.length > 0) return { ok: false, reason: "scope_too_broad", excess };
  return { ok: true };
};

/**
 * Normalizes an operator-supplied peer origin. Rejects anything that is not an
 * absolute http(s) URL so a malformed entry fails at registration rather than
 * on first use, and drops any path/query so the API client owns route joining.
 */
export const normalizePeerBaseUrl = (value: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed.origin;
};

const makePeerClient = (baseUrl: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl });

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` }) as const;

/**
 * Redeems a peer's single-use pairing token for a bearer access token, asking
 * for `orchestration:read` only. The peer re-checks that the pairing token
 * actually carries the requested scope, so a token minted with more privilege
 * still yields a read-only credential here.
 */
export const exchangePeerPairingToken = Effect.fn("peers.exchangePairingToken")(function* (input: {
  readonly baseUrl: string;
  readonly pairingToken: string;
  readonly label: string;
  readonly credentialClass: PeerCredentialClass;
}) {
  const client = yield* makePeerClient(input.baseUrl);
  return yield* client.auth
    .token({
      headers: {},
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: input.pairingToken,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope: encodeOAuthScope([...peerCredentialScopes(input.credentialClass)]),
        client_label: input.label,
      },
    })
    .pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});

/**
 * Asks the peer what a bearer token actually grants. Used to validate a
 * directly-supplied peer token: the granted scopes come from the peer's own
 * session store, so a caller cannot misdeclare what they pasted in.
 */
export const fetchPeerSessionState = Effect.fn("peers.fetchSessionState")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
}) {
  const client = yield* makePeerClient(input.baseUrl);
  return yield* client.auth
    .session({ headers: bearer(input.credential) })
    .pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});

/** Unauthenticated peer identity probe, used to stamp the registry entry. */
export const fetchPeerDescriptor = Effect.fn("peers.fetchDescriptor")(function* (baseUrl: string) {
  const client = yield* makePeerClient(baseUrl);
  return yield* client.metadata.descriptor().pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});

export const fetchPeerShellSnapshot = Effect.fn("peers.fetchShellSnapshot")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
}) {
  const client = yield* makePeerClient(input.baseUrl);
  return yield* client.orchestration
    .shellSnapshot({ headers: bearer(input.credential) })
    .pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});

/**
 * The peer's project catalog — its own half, not the folded view.
 *
 * Used to turn a project slug into the `projectId` that machine actually
 * binds. The slug is the one identifier that means the same thing everywhere,
 * which is precisely why it is the thing worth sending across a peer boundary;
 * the id it resolves to is local to the peer and never leaves it except as the
 * target of the create that follows.
 */
export const fetchPeerProjectCatalog = Effect.fn("peers.fetchProjectCatalog")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
}) {
  const client = yield* makePeerClient(input.baseUrl);
  return yield* client.projectCatalog
    .snapshot({ headers: bearer(input.credential) })
    .pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});

export const fetchPeerThreadSnapshot = Effect.fn("peers.fetchThreadSnapshot")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly threadId: ThreadId;
}) {
  const client = yield* makePeerClient(input.baseUrl);
  return yield* client.orchestration
    .threadSnapshot({ params: { threadId: input.threadId }, headers: bearer(input.credential) })
    .pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});

/**
 * Leaves a message in a peer thread's mailbox. Note what this is *not*: it does
 * not go through the peer's dispatch endpoint, so it cannot start a turn there
 * even if this environment wanted it to.
 */
export const sendPeerMailboxMessage = Effect.fn("peers.sendMailboxMessage")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly threadId: ThreadId;
  readonly payload: ThreadMailboxSendInput;
}) {
  const client = yield* makePeerClient(input.baseUrl);
  return yield* client.mailbox
    .send({
      params: { threadId: input.threadId },
      payload: input.payload,
      headers: bearer(input.credential),
    })
    .pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});

/**
 * Dispatches an orchestration command on a peer. Both thread creation and the
 * interrupt-style dispatch go through here, because both are ordinary commands
 * on the peer's existing endpoint — the fork adds no write route for either.
 */
export const dispatchPeerCommand = Effect.fn("peers.dispatchCommand")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly command: ClientOrchestrationCommand;
}) {
  const client = yield* makePeerClient(input.baseUrl);
  // The generated client types `dispatch` as a union of one argument shape per
  // command variant, so a value typed as the whole command union does not
  // narrow to any single member. The payload is schema-checked by the peer on
  // arrival regardless, which is where it matters.
  return yield* client.orchestration
    .dispatch({
      payload: input.command,
      headers: bearer(input.credential),
    } as unknown as Parameters<typeof client.orchestration.dispatch>[0])
    .pipe(Effect.timeout(PEER_REQUEST_TIMEOUT));
});
