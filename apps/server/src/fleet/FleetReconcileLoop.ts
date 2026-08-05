/**
 * Periodic convergence/index refresh. Registration also reconciles
 * immediately; this loop repairs temporary failures and keeps the fleet thread
 * index current.
 *
 * @module FleetReconcileLoop
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FleetReconciler } from "./FleetReconciler.ts";
import { syncPiAccountsToFleet } from "./PiAccountFleetSync.ts";

export const runFleetReconcileTick = <A, E, R, B, E2, R2>(
  reconcile: Effect.Effect<A, E, R>,
  syncAccounts: Effect.Effect<B, E2, R2>,
) =>
  Effect.gen(function* () {
    yield* reconcile.pipe(
      Effect.catchCause(() => Effect.logWarning("Fleet reconcile tick failed")),
    );
    yield* syncAccounts.pipe(
      Effect.catchCause(() => Effect.logWarning("Automatic Pi account sync tick failed")),
    );
  });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reconciler = yield* FleetReconciler;
    yield* Effect.gen(function* () {
      yield* Effect.sleep("30 seconds");
      yield* runFleetReconcileTick(reconciler.reconcile, syncPiAccountsToFleet);
    }).pipe(Effect.forever, Effect.forkScoped);
  }),
);
