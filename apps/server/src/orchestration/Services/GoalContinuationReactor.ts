import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface GoalContinuationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class GoalContinuationReactor extends Context.Service<
  GoalContinuationReactor,
  GoalContinuationReactorShape
>()("starcode/orchestration/Services/GoalContinuationReactor") {}
