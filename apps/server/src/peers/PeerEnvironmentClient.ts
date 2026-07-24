/**
 * PeerEnvironmentClient - typed HTTP access to another t3 environment.
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
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  type ThreadId,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

/**
 * Bounded so one unreachable machine cannot stall a multi-peer listing (or an
 * agent's tool call) for longer than an agent is willing to wait.
 */
export const PEER_REQUEST_TIMEOUT = Duration.seconds(10);

/** Scope every peer credential is narrowed to. Federation is read-only. */
export const PEER_CREDENTIAL_SCOPES = [AuthOrchestrationReadScope] as const;

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
        scope: encodeOAuthScope([...PEER_CREDENTIAL_SCOPES]),
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
