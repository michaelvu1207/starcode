import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const THREAD_GOAL_OBJECTIVE_MAX_CHARS = 4_000;

export const ThreadGoalObjective = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_GOAL_OBJECTIVE_MAX_CHARS),
);
export type ThreadGoalObjective = typeof ThreadGoalObjective.Type;

export const ThreadGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

/**
 * Provider-neutral goal state attached to a thread.
 *
 * Providers own execution semantics. Starcode persists this projection so the
 * same goal is visible after reconnecting and from every client surface.
 */
export const ThreadGoal = Schema.Struct({
  objective: ThreadGoalObjective,
  status: ThreadGoalStatus,
  tokenBudget: Schema.NullOr(PositiveInt),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ThreadGoalField = Schema.optional(Schema.NullOr(ThreadGoal));

export const ThreadGoalSummary = Schema.Struct({
  status: ThreadGoalStatus,
  updatedAt: IsoDateTime,
});
export type ThreadGoalSummary = typeof ThreadGoalSummary.Type;

export const ThreadGoalSummaryField = Schema.optional(Schema.NullOr(ThreadGoalSummary));

export const ProviderGetGoalInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderGetGoalInput = typeof ProviderGetGoalInput.Type;

export const ProviderSetGoalInput = Schema.Struct({
  threadId: ThreadId,
  objective: Schema.optional(ThreadGoalObjective),
  status: Schema.optional(ThreadGoalStatus),
  tokenBudget: Schema.optional(Schema.NullOr(PositiveInt)),
});
export type ProviderSetGoalInput = typeof ProviderSetGoalInput.Type;

export const ProviderClearGoalInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderClearGoalInput = typeof ProviderClearGoalInput.Type;

export const GoalToolOperation = Schema.Literals(["get", "progress", "complete", "blocked"]);
export type GoalToolOperation = typeof GoalToolOperation.Type;

export class GoalToolError extends Schema.TaggedErrorClass<GoalToolError>()("GoalToolError", {
  operation: GoalToolOperation,
  reason: Schema.Literals(["goal_not_found", "goal_terminal", "storage_failed"]),
  detail: TrimmedNonEmptyString,
}) {}

export const GoalGetToolInput = Schema.Struct({});
export const GoalGetToolResult = Schema.Struct({ goal: Schema.NullOr(ThreadGoal) });
export const GoalProgressToolInput = Schema.Struct({ detail: TrimmedNonEmptyString });
export const GoalTerminalToolInput = Schema.Struct({
  detail: Schema.optional(TrimmedNonEmptyString),
});
export const GoalToolResult = Schema.Struct({ goal: ThreadGoal });
