/**
 * Fleet HTTP bindings.
 *
 * Viewer bootstrap is read-scoped; roster mutation and node exchange are
 * administrative. All lifecycle work remains in FleetReconciler/Registry.
 *
 * @module FleetHttp
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@starcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { FleetReconciler, isFleetRegistrationError } from "./FleetReconciler.ts";
import { FleetRegistry } from "./FleetRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { importTransferablePiAccounts } from "../provider/pi/PiAccountCatalog.ts";

/** Every bootstrap credential is attenuated to the authenticated caller. */
export const FLEET_CLIENT_BOOTSTRAP_REQUIRED_SCOPE = AuthOrchestrationReadScope;
export const FLEET_ACCOUNT_IMPORT_REQUIRED_SCOPE = AuthAccessWriteScope;

export const fleetHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "fleet",
  Effect.fnUntraced(function* (handlers) {
    const registry = yield* FleetRegistry;
    const reconciler = yield* FleetReconciler;
    const config = yield* ServerConfig.ServerConfig;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.fleet.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessReadScope);
          yield* reconciler
            .ensureSelf()
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return yield* registry.snapshot.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "register",
        Effect.fn("environment.fleet.register")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* reconciler.register(args.payload).pipe(
            Effect.catchIf(isFleetRegistrationError, (error) =>
              Effect.logWarning("fleet registration rejected", {
                node: error.name,
                reason: error.reason,
              }).pipe(Effect.andThen(failEnvironmentInvalidRequest("invalid_peer"))),
            ),
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.fleet.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* reconciler
            .remove(args.payload.environmentId, now)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "reconcile",
        Effect.fn("environment.fleet.reconcile")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* reconciler.reconcile.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "exchange",
        Effect.fn("environment.fleet.exchange")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* reconciler
            .exchange(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "clientBootstrap",
        Effect.fn("environment.fleet.clientBootstrap")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(FLEET_CLIENT_BOOTSTRAP_REQUIRED_SCOPE);
          return yield* reconciler
            .clientBootstrap(principal.scopes)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "importAccounts",
        Effect.fn("environment.fleet.importAccounts")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(FLEET_ACCOUNT_IMPORT_REQUIRED_SCOPE);
          const result = yield* Effect.tryPromise(() =>
            importTransferablePiAccounts({
              stateDir: config.stateDir,
              secretsDir: config.secretsDir,
              accounts: args.payload.accounts,
            }),
          ).pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          yield* providerRegistry.refresh().pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Provider refresh failed after fleet account import"),
            ),
            Effect.forkDetach,
          );
          return result;
        }),
      );
  }),
);
