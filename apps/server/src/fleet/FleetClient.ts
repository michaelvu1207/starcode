/**
 * Typed HTTP operations used for node-to-node fleet reconciliation.
 *
 * @module FleetClient
 */
import {
  AuthAccessTokenType,
  AuthAdministrativeScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type ClientOrchestrationCommand,
  type FleetExchangeInput,
  type ProjectCatalogFileThreadRequest,
  type ProjectCatalogRemoveRequest,
  type ProjectCatalogUpsertRequest,
  type ThreadId,
  type ThreadMailboxSendInput,
} from "@starcode/contracts";
import { encodeOAuthScope } from "@starcode/shared/oauthScope";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

export const FLEET_REQUEST_TIMEOUT = Duration.seconds(10);

const makeClient = (baseUrl: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl });
const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` }) as const;

export const exchangeFleetPairingToken = Effect.fn("FleetClient.exchangePairingToken")(
  function* (input: {
    readonly baseUrl: string;
    readonly pairingToken: string;
    readonly label: string;
  }) {
    const client = yield* makeClient(input.baseUrl);
    return yield* client.auth
      .token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: input.pairingToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: encodeOAuthScope([...AuthAdministrativeScopes]),
          client_label: input.label,
          client_device_type: "bot",
        },
      })
      .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  },
);

export const fetchFleetSessionState = Effect.fn("FleetClient.fetchSessionState")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
}) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.auth
    .session({ headers: bearer(input.credential) })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

export const fetchFleetDescriptor = Effect.fn("FleetClient.fetchDescriptor")(function* (
  baseUrl: string,
) {
  const client = yield* makeClient(baseUrl);
  return yield* client.metadata.descriptor().pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

export const fetchFleetSnapshot = Effect.fn("FleetClient.fetchSnapshot")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
}) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.fleet
    .snapshot({ headers: bearer(input.credential) })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

export const exchangeFleetRoster = Effect.fn("FleetClient.exchangeRoster")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly payload: FleetExchangeInput;
}) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.fleet
    .exchange({
      headers: bearer(input.credential),
      payload: input.payload,
    })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

export const mintRemoteFleetPairingCredential = Effect.fn(
  "FleetClient.mintRemoteFleetPairingCredential",
)(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly label: string;
}) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.auth
    .pairingCredential({
      headers: bearer(input.credential),
      payload: {
        label: input.label,
        scopes: [...AuthAdministrativeScopes],
      },
    })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

/**
 * Mint and immediately exchange an authority-attenuated viewer credential on a
 * remote node. The administrative node credential never leaves the server.
 */
export const mintRemoteStandardClientAccess = Effect.fn(
  "FleetClient.mintRemoteStandardClientAccess",
)(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly label: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const client = yield* makeClient(input.baseUrl);
  const pairing = yield* client.auth
    .pairingCredential({
      headers: bearer(input.credential),
      payload: {
        label: input.label,
        scopes: [...input.scopes],
        subject: "fleet-client-bootstrap",
      },
    })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  return yield* client.auth
    .token({
      headers: {},
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: pairing.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope: encodeOAuthScope(input.scopes),
        client_label: input.label,
      },
    })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

/** Read the owning node's current shell projection. */
export const fetchFleetShellSnapshot = Effect.fn("FleetClient.fetchShellSnapshot")(
  function* (input: { readonly baseUrl: string; readonly credential: string }) {
    const client = yield* makeClient(input.baseUrl);
    return yield* client.orchestration
      .shellSnapshot({ headers: bearer(input.credential) })
      .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  },
);

/** Read project placement metadata from the owning node. */
export const fetchFleetProjectCatalog = Effect.fn("FleetClient.fetchProjectCatalog")(
  function* (input: { readonly baseUrl: string; readonly credential: string }) {
    const client = yield* makeClient(input.baseUrl);
    return yield* client.projectCatalog
      .snapshot({ headers: bearer(input.credential) })
      .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  },
);

/** List physical project folders and their logical-project bindings on one node. */
export const fetchFleetProjectCatalogLocations = Effect.fn(
  "FleetClient.fetchProjectCatalogLocations",
)(function* (input: { readonly baseUrl: string; readonly credential: string }) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.projectCatalog
    .locations({ headers: bearer(input.credential) })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

/** Create or patch one logical project category on its owning node. */
export const upsertFleetProjectCatalog = Effect.fn("FleetClient.upsertProjectCatalog")(
  function* (input: {
    readonly baseUrl: string;
    readonly credential: string;
    readonly payload: ProjectCatalogUpsertRequest;
  }) {
    const client = yield* makeClient(input.baseUrl);
    return yield* client.projectCatalog
      .upsert({ headers: bearer(input.credential), payload: input.payload })
      .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  },
);

/** Remove one logical project category from its owning node. */
export const removeFleetProjectCatalog = Effect.fn("FleetClient.removeProjectCatalog")(
  function* (input: {
    readonly baseUrl: string;
    readonly credential: string;
    readonly payload: ProjectCatalogRemoveRequest;
  }) {
    const client = yield* makeClient(input.baseUrl);
    return yield* client.projectCatalog
      .remove({ headers: bearer(input.credential), payload: input.payload })
      .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  },
);

/** File, exclude, or unfile a thread on its owning node. */
export const fileFleetProjectThread = Effect.fn("FleetClient.fileProjectThread")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly payload: ProjectCatalogFileThreadRequest;
}) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.projectCatalog
    .fileThread({ headers: bearer(input.credential), payload: input.payload })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

/** Read the orchestrator-authored feature overlay used by project_get. */
export const fetchFleetFeatureMap = Effect.fn("FleetClient.fetchFeatureMap")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
}) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.featureFlow
    .map({ headers: bearer(input.credential) })
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});

/** Read one transcript from its owning node. */
export const fetchFleetThreadSnapshot = Effect.fn("FleetClient.fetchThreadSnapshot")(
  function* (input: {
    readonly baseUrl: string;
    readonly credential: string;
    readonly threadId: ThreadId;
  }) {
    const client = yield* makeClient(input.baseUrl);
    return yield* client.orchestration
      .threadSnapshot({
        params: { threadId: input.threadId },
        headers: bearer(input.credential),
      })
      .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  },
);

/** Queue a mailbox message on the owning node. */
export const sendFleetMailboxMessage = Effect.fn("FleetClient.sendMailboxMessage")(
  function* (input: {
    readonly baseUrl: string;
    readonly credential: string;
    readonly threadId: ThreadId;
    readonly payload: ThreadMailboxSendInput;
  }) {
    const client = yield* makeClient(input.baseUrl);
    return yield* client.mailbox
      .send({
        params: { threadId: input.threadId },
        payload: input.payload,
        headers: bearer(input.credential),
      })
      .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
  },
);

/** Dispatch a lifecycle command on the owning node. */
export const dispatchFleetCommand = Effect.fn("FleetClient.dispatchCommand")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
  readonly command: ClientOrchestrationCommand;
}) {
  const client = yield* makeClient(input.baseUrl);
  return yield* client.orchestration
    .dispatch({
      payload: input.command,
      headers: bearer(input.credential),
    } as unknown as Parameters<typeof client.orchestration.dispatch>[0])
    .pipe(Effect.timeout(FLEET_REQUEST_TIMEOUT));
});
