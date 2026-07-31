import type { EnvironmentId } from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Fleet from "./fleet.ts";
import * as EnvironmentRegistry from "./registry.ts";

export class FleetConnectionCoordinator extends Context.Service<
  FleetConnectionCoordinator,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@starcode/client-runtime/connection/fleetCoordinator/FleetConnectionCoordinator") {}

const anchorKey = (environmentIds: ReadonlyArray<EnvironmentId>): string =>
  environmentIds.join("\u0000");

type FleetCoordinatorRegistry = Pick<
  EnvironmentRegistry.EnvironmentRegistry["Service"],
  "entries" | "fleetEnvironmentIds" | "reconcileFleet" | "reconcileFleetAnchors"
>;

export const startFleetConnectionCoordinator = Effect.fn("FleetConnectionCoordinator.start")(
  function* (
    registry: FleetCoordinatorRegistry,
    discovery: Fleet.FleetConnectionDiscoveryService,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    const discoverAnchor = (anchorEnvironmentId: EnvironmentId) =>
      discovery.watch(anchorEnvironmentId).pipe(
        Stream.runForEach((snapshot) => registry.reconcileFleet(anchorEnvironmentId, snapshot)),
        Effect.catch((cause) =>
          Effect.logWarning("Fleet discovery stopped for an anchor environment.", {
            anchorEnvironmentId,
            cause,
          }),
        ),
      );

    yield* Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.mapEffect((entries) =>
        SubscriptionRef.get(registry.fleetEnvironmentIds).pipe(
          Effect.map((fleetEnvironmentIds) =>
            [...entries.keys()]
              .filter((environmentId) => !fleetEnvironmentIds.has(environmentId))
              .sort((left, right) => left.localeCompare(right)),
          ),
        ),
      ),
      Stream.changesWith((left, right) => anchorKey(left) === anchorKey(right)),
      Stream.tap((anchors) => registry.reconcileFleetAnchors(new Set(anchors))),
      Stream.switchMap((anchors) =>
        Stream.mergeAll(
          anchors.map((anchorEnvironmentId) =>
            Stream.fromEffect(discoverAnchor(anchorEnvironmentId)),
          ),
          { concurrency: "unbounded" },
        ),
      ),
      Stream.runDrain,
      Effect.forkScoped,
      Effect.asVoid,
      Effect.withSpan("FleetConnectionCoordinator.start"),
    );
  },
);

export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const discovery = yield* Fleet.FleetConnectionDiscovery;

  return FleetConnectionCoordinator.of({
    start: startFleetConnectionCoordinator(registry, discovery),
  });
});

export const layer = Layer.effect(FleetConnectionCoordinator, make);
