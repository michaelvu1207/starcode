import { ConnectionOnboarding, EnvironmentRegistry } from "@starcode/client-runtime/connection";
import { runFleetOnboarding } from "@starcode/client-runtime/onboarding";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@starcode/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@starcode/contracts";
import * as Effect from "effect/Effect";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { pairingUrl?: string; host?: string; pairingCode?: string }) =>
      JSON.stringify(input),
  },
  execute: (input: {
    readonly pairingUrl?: string;
    readonly host?: string;
    readonly pairingCode?: string;
  }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerPairing(input))),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: { readonly target: DesktopSshEnvironmentTarget; readonly label?: string }) =>
    ConnectionOnboarding.pipe(Effect.flatMap((onboarding) => onboarding.registerSsh(input))),
});

export const onboardFleetHost = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:onboard-fleet-host",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly hostname: string }) => input.hostname.trim().toLocaleLowerCase(),
  },
  execute: (input: { readonly hostname: string }) => runFleetOnboarding(input),
});

export const removeFleetEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:remove-fleet-environment",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (environmentId: EnvironmentId) => environmentId,
  },
  execute: (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      const bootstrap = yield* Effect.tryPromise(() =>
        runPrimaryHttp(
          PrimaryEnvironmentHttpClient.pipe(
            Effect.flatMap((client) =>
              Effect.gen(function* () {
                yield* client.fleet.remove({
                  headers: {},
                  payload: { environmentId },
                });
                return yield* Effect.all({
                  descriptor: client.metadata.descriptor(),
                  snapshot: client.fleet.clientBootstrap({ headers: {}, payload: {} }),
                });
              }),
            ),
          ),
        ),
      );
      yield* registry.reconcileFleet(bootstrap.descriptor.environmentId, bootstrap.snapshot);
    }),
});
