import { EnvironmentId } from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { FleetConnectionSnapshot } from "./fleet.ts";
import { startFleetConnectionCoordinator } from "./fleetCoordinator.ts";
import { PrimaryConnectionTarget } from "./model.ts";

describe("FleetConnectionCoordinator", () => {
  it.effect("discovers from one anchor and retires its snapshot when the anchor disappears", () =>
    Effect.gen(function* () {
      const alphaEnvironmentId = EnvironmentId.make("alpha");
      const betaEnvironmentId = EnvironmentId.make("beta");
      const alphaEntry: ConnectionCatalogEntry = {
        target: new PrimaryConnectionTarget({
          environmentId: alphaEnvironmentId,
          label: "Alpha",
          httpBaseUrl: "https://alpha.example.test",
          wsBaseUrl: "wss://alpha.example.test",
        }),
        profile: Option.none(),
      };
      const snapshot: FleetConnectionSnapshot = {
        revision: 1,
        nodes: [
          {
            nodeId: "beta",
            environmentId: betaEnvironmentId,
            label: "Beta",
            endpoint: {
              httpBaseUrl: "https://beta.example.test",
              wsBaseUrl: "wss://beta.example.test",
            },
            credential: { bearerToken: "ephemeral-beta-token" },
          },
        ],
      };
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[alphaEnvironmentId, alphaEntry]]));
      const fleetEnvironmentIds = yield* SubscriptionRef.make<ReadonlySet<EnvironmentId>>(
        new Set(),
      );
      const discovered = yield* Deferred.make<void>();
      const anchorRetired = yield* Deferred.make<void>();
      const observedSnapshots = yield* SubscriptionRef.make<
        ReadonlyArray<readonly [EnvironmentId, FleetConnectionSnapshot]>
      >([]);

      const registry = {
        entries,
        fleetEnvironmentIds,
        reconcileFleet: (anchorEnvironmentId: EnvironmentId, next: FleetConnectionSnapshot) =>
          SubscriptionRef.update(observedSnapshots, (current) => [
            ...current,
            [anchorEnvironmentId, next] as const,
          ]).pipe(Effect.andThen(Deferred.succeed(discovered, undefined)), Effect.asVoid),
        reconcileFleetAnchors: (anchorEnvironmentIds: ReadonlySet<EnvironmentId>) =>
          anchorEnvironmentIds.size === 0
            ? Deferred.succeed(anchorRetired, undefined).pipe(Effect.asVoid)
            : Effect.void,
      };
      const discovery = {
        watch: (anchorEnvironmentId: EnvironmentId) => {
          expect(anchorEnvironmentId).toBe(alphaEnvironmentId);
          return Stream.concat(Stream.succeed(snapshot), Stream.never);
        },
      };

      yield* startFleetConnectionCoordinator(registry, discovery);
      yield* Deferred.await(discovered).pipe(Effect.timeout("1 second"));

      expect(yield* SubscriptionRef.get(observedSnapshots)).toEqual([
        [alphaEnvironmentId, snapshot],
      ]);

      yield* SubscriptionRef.set(entries, new Map());
      yield* Deferred.await(anchorRetired).pipe(Effect.timeout("1 second"));
    }).pipe(Effect.scoped),
  );
});
