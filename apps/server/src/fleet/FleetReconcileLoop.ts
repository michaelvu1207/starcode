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

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reconciler = yield* FleetReconciler;
    yield* Effect.gen(function* () {
      yield* Effect.sleep("30 seconds");
      yield* reconciler.reconcile.pipe(
        Effect.catchCause(() => Effect.logWarning("Fleet reconcile tick failed")),
      );
    }).pipe(Effect.forever, Effect.forkScoped);
  }),
);
