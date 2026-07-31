import {
  EnvironmentId,
  type FleetClientBootstrapNode,
  type FleetClientBootstrapResult,
} from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { BearerConnectionCredential } from "./catalog.ts";

export type FleetNodeConnectionDescriptor = FleetClientBootstrapNode;

/**
 * A complete view of the nodes reachable through one anchor environment.
 *
 * An empty `nodes` array is meaningful: it removes every fleet-derived
 * connection previously learned through that anchor. Discovery failures do
 * not produce an empty snapshot, so transient failures retain the last known
 * topology.
 */
export type FleetConnectionSnapshot = FleetClientBootstrapResult;

export class FleetConnectionDiscoveryError extends Schema.TaggedErrorClass<FleetConnectionDiscoveryError>()(
  "FleetConnectionDiscoveryError",
  {
    anchorEnvironmentId: EnvironmentId,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface FleetConnectionDiscoveryService {
  readonly watch: (
    anchorEnvironmentId: EnvironmentId,
  ) => Stream.Stream<FleetConnectionSnapshot, FleetConnectionDiscoveryError>;
}

/**
 * The shared HTTP binding supplies this adapter for both web and mobile.
 */
export class FleetConnectionDiscovery extends Context.Service<
  FleetConnectionDiscovery,
  FleetConnectionDiscoveryService
>()("@starcode/client-runtime/connection/fleet/FleetConnectionDiscovery") {}

export interface FleetConnectionCredentialStoreService {
  readonly get: (connectionId: string) => Effect.Effect<Option.Option<BearerConnectionCredential>>;
  readonly put: (
    connectionId: string,
    credential: BearerConnectionCredential,
  ) => Effect.Effect<void>;
  readonly remove: (connectionId: string) => Effect.Effect<void>;
}

/**
 * Fleet bootstrap credentials deliberately live only in process memory. They
 * are never handed to the platform persistence services used by normal bearer
 * connections.
 */
export const makeFleetConnectionCredentialStore = (): FleetConnectionCredentialStoreService => {
  const credentials = new Map<string, BearerConnectionCredential>();
  return {
    get: (connectionId) => Effect.sync(() => Option.fromUndefinedOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => {
        credentials.set(connectionId, credential);
      }),
    remove: (connectionId) =>
      Effect.sync(() => {
        credentials.delete(connectionId);
      }),
  };
};

export class FleetConnectionCredentialStore extends Context.Reference<FleetConnectionCredentialStoreService>(
  "@starcode/client-runtime/connection/fleet/FleetConnectionCredentialStore",
  {
    defaultValue: makeFleetConnectionCredentialStore,
  },
) {}

export const fleetConnectionId = (environmentId: EnvironmentId): string => `fleet:${environmentId}`;
