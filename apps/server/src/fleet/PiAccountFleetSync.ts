/**
 * Automatic, additive Pi subscription-account convergence across the fleet.
 * Credentials only travel over authenticated administrative fleet requests and
 * are never written to the public roster or returned to clients.
 */
import { PiAccountAuthError } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { exportTransferablePiAccounts } from "../provider/pi/PiAccountCatalog.ts";
import { importFleetPiAccounts } from "./FleetClient.ts";
import { FleetRegistry } from "./FleetRegistry.ts";

export const syncPiAccountsToFleet = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const fleetRegistry = yield* FleetRegistry;
  const httpClient = yield* HttpClient.HttpClient;

  const accounts = yield* Effect.tryPromise(() =>
    exportTransferablePiAccounts({
      stateDir: config.stateDir,
      secretsDir: config.secretsDir,
    }),
  ).pipe(
    Effect.mapError(
      () =>
        new PiAccountAuthError({
          reason: "sync_failed",
          message: "Accounts could not be prepared for synchronization.",
        }),
    ),
  );
  const self = yield* serverEnvironment.getDescriptor;
  const roster = yield* fleetRegistry.snapshot.pipe(
    Effect.mapError(
      () =>
        new PiAccountAuthError({
          reason: "sync_failed",
          message: "The fleet roster could not be read.",
        }),
    ),
  );
  const targets = yield* Effect.forEach(
    roster.members.filter((member) => member.node.environmentId !== self.environmentId),
    (member) =>
      fleetRegistry.resolveByEnvironmentId(member.node.environmentId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.succeed({
                environmentId: member.node.environmentId,
                label: member.node.label,
                status: "pending" as const,
                imported: 0,
              }),
            onSome: (resolved) => {
              const endpoint =
                resolved.member.node.endpoints.find((candidate) => candidate.isDefault) ??
                resolved.member.node.endpoints[0];
              if (endpoint === undefined) {
                return Effect.succeed({
                  environmentId: member.node.environmentId,
                  label: member.node.label,
                  status: "pending" as const,
                  imported: 0,
                });
              }
              return importFleetPiAccounts({
                baseUrl: endpoint.httpBaseUrl,
                credential: resolved.credential,
                payload: { accounts },
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.map((result) => ({
                  environmentId: member.node.environmentId,
                  label: member.node.label,
                  status: "synced" as const,
                  imported: result.imported,
                })),
                Effect.catchCause(() =>
                  Effect.succeed({
                    environmentId: member.node.environmentId,
                    label: member.node.label,
                    status: "pending" as const,
                    imported: 0,
                  }),
                ),
              );
            },
          }),
        ),
        Effect.catchCause(() =>
          Effect.succeed({
            environmentId: member.node.environmentId,
            label: member.node.label,
            status: "pending" as const,
            imported: 0,
          }),
        ),
      ),
    { concurrency: 4 },
  );

  return { exported: accounts.length, targets };
}).pipe(Effect.withSpan("PiAccountFleetSync.sync"));
