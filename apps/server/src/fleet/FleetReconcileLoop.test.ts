import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { runFleetReconcileTick } from "./FleetReconcileLoop.ts";

describe("FleetReconcileLoop", () => {
  it("automatically syncs accounts after every fleet reconciliation tick", async () => {
    const calls: Array<string> = [];

    await Effect.runPromise(
      runFleetReconcileTick(
        Effect.sync(() => calls.push("reconcile")),
        Effect.sync(() => calls.push("sync-accounts")),
      ),
    );

    expect(calls).toEqual(["reconcile", "sync-accounts"]);
  });

  it("still retries account sync when fleet reconciliation fails", async () => {
    let syncCount = 0;

    await Effect.runPromise(
      runFleetReconcileTick(
        Effect.fail("offline"),
        Effect.sync(() => {
          syncCount += 1;
        }),
      ),
    );

    expect(syncCount).toBe(1);
  });
});
