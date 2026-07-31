import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadGoal, ThreadGoalObjective } from "./threadGoal.ts";

const decodeObjective = Schema.decodeUnknownEffect(ThreadGoalObjective);
const decodeGoal = Schema.decodeUnknownEffect(ThreadGoal);

it.effect("trims and accepts a valid goal objective", () =>
  Effect.gen(function* () {
    const objective = yield* decodeObjective("  Finish goal support  ");
    assert.strictEqual(objective, "Finish goal support");
  }),
);

it.effect("rejects empty and oversized goal objectives", () =>
  Effect.gen(function* () {
    const empty = yield* Effect.exit(decodeObjective("   "));
    const oversized = yield* Effect.exit(decodeObjective("x".repeat(4_001)));
    assert.strictEqual(empty._tag, "Failure");
    assert.strictEqual(oversized._tag, "Failure");
  }),
);

it.effect("decodes every native Codex goal status", () =>
  Effect.gen(function* () {
    for (const status of [
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ] as const) {
      const goal = yield* decodeGoal({
        objective: "Finish goal support",
        status,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(goal.status, status);
    }
  }),
);
