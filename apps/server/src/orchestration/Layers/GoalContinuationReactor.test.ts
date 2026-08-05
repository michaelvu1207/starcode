import { describe, expect, it } from "vite-plus/test";

import {
  activeManagedGoalThreadIds,
  type ManagedGoalContinuationCandidate,
  shouldContinueManagedGoal,
} from "./GoalContinuationReactor.ts";

const ready: ManagedGoalContinuationCandidate = {
  archivedAt: null,
  session: { providerName: "claudeAgent", status: "ready", activeTurnId: null },
  goalSummary: { status: "active" },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  subagents: [],
  latestTurn: { state: "completed" },
};

describe("shouldContinueManagedGoal", () => {
  it("continues an idle Claude thread with an active managed goal", () => {
    expect(shouldContinueManagedGoal(ready)).toBe(true);
  });

  it("selects only active managed goals for periodic reconciliation", () => {
    expect(
      activeManagedGoalThreadIds([
        { id: "active" as never, goalSummary: { status: "active" } },
        { id: "complete" as never, goalSummary: { status: "complete" } },
        { id: "blocked" as never, goalSummary: { status: "blocked" } },
        { id: "none" as never },
      ]),
    ).toEqual(["active"]);
  });

  it("continues an idle native Pi thread with an active managed goal", () => {
    expect(
      shouldContinueManagedGoal({
        ...ready,
        session: { ...ready.session!, providerName: "pi" },
      }),
    ).toBe(true);
  });

  it("rehydrates a stopped native Pi session when its managed goal is still active", () => {
    expect(
      shouldContinueManagedGoal({
        ...ready,
        session: { ...ready.session!, providerName: "pi", status: "stopped" },
      }),
    ).toBe(true);
  });

  it.each([
    ["approval", { hasPendingApprovals: true }],
    ["user input", { hasPendingUserInput: true }],
    ["subagent", { subagents: [{}] }],
    ["running turn", { latestTurn: { state: "running" } }],
    ["completed goal", { goalSummary: { status: "complete" } }],
    ["native-goal provider", { session: { ...ready.session!, providerName: "codex" } }],
  ])("does not continue while blocked by %s", (_label, override) => {
    expect(shouldContinueManagedGoal({ ...ready, ...override })).toBe(false);
  });
});
