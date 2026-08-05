import type { EnvironmentId } from "@starcode/contracts";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Fleet from "./fleet.ts";
import type { PreparedConnection } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { EnvironmentSupervisor } from "./supervisor.ts";

const DEFAULT_FLEET_BOOTSTRAP_TIMEOUT_MS = 6_000;
const DEFAULT_FLEET_POLL_INTERVAL = "60 seconds";

export function fleetDiscoveryFailureLogAttributes(cause: Cause.Cause<unknown>) {
  const failure = cause.reasons.find(Cause.isFailReason);
  const error = failure?.error;
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  const safe = safeErrorLogAttributes(error ?? cause);
  return {
    failureCategory: failure === undefined ? "defect-or-interruption" : "request",
    errorType: safe.errorType,
    ...(safe.errorName === undefined ? {} : { errorName: safe.errorName }),
    ...(safe.errorTag === undefined ? {} : { errorTag: safe.errorTag }),
    ...(safe.traceId === undefined ? {} : { traceId: safe.traceId }),
    ...(status === undefined ? {} : { httpStatus: status }),
  } as const;
}

export const fetchFleetConnectionSnapshot = Effect.fn(
  "clientRuntime.connection.fetchFleetConnectionSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/fleet/client-bootstrap",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_FLEET_BOOTSTRAP_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.fleet.clientBootstrap({ headers, payload: {} }),
    ),
  );
});

export interface FleetHttpConnectionDiscoveryOptions {
  readonly pollInterval?: Duration.Input;
  readonly timeoutMs?: number;
}

export const makeFleetHttpConnectionDiscovery = Effect.fn(
  "clientRuntime.connection.makeFleetHttpConnectionDiscovery",
)(function* (options: FleetHttpConnectionDiscoveryOptions = {}) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const httpClient = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);

  const poll = (anchorEnvironmentId: EnvironmentId, prepared: PreparedConnection) =>
    Stream.fromEffectSchedule(
      fetchFleetConnectionSnapshot({
        prepared,
        signer,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.map(Result.succeed),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Could not refresh fleet client connections; retaining the last known fleet snapshot.",
          ).pipe(
            Effect.annotateLogs({
              anchorEnvironmentId,
              ...fleetDiscoveryFailureLogAttributes(cause),
            }),
            Effect.as(Result.failVoid),
          ),
        ),
      ),
      Schedule.spaced(options.pollInterval ?? DEFAULT_FLEET_POLL_INTERVAL),
    ).pipe(Stream.filterMap((result) => result));

  const watch: Fleet.FleetConnectionDiscoveryService["watch"] = (anchorEnvironmentId) =>
    registry
      .runStream(
        anchorEnvironmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              Stream.concat(
                Stream.fromEffect(SubscriptionRef.get(supervisor.prepared)),
                SubscriptionRef.changes(supervisor.prepared),
              ).pipe(
                Stream.changes,
                Stream.switchMap(
                  Option.match({
                    onNone: () => Stream.empty,
                    onSome: (prepared) => poll(anchorEnvironmentId, prepared),
                  }),
                ),
              ),
            ),
          ),
        ),
      )
      .pipe(Stream.catchTag("EnvironmentNotRegisteredError", () => Stream.empty));

  return Fleet.FleetConnectionDiscovery.of({ watch });
});

export const layer: Layer.Layer<
  Fleet.FleetConnectionDiscovery,
  never,
  EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
> = Layer.effect(Fleet.FleetConnectionDiscovery, makeFleetHttpConnectionDiscovery());
