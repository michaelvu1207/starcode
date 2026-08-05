import { CommandId, MessageId, type ThreadId } from "@starcode/contracts";
import { makeDrainableWorker } from "@starcode/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  GoalContinuationReactor,
  type GoalContinuationReactorShape,
} from "../Services/GoalContinuationReactor.ts";

const CONTINUATION_DELAY = "200 millis";
const RECONCILIATION_INTERVAL = "5 seconds";
const MANAGED_GOAL_PROVIDERS = new Set(["claudeAgent", "pi"]);

export interface ManagedGoalContinuationCandidate {
  readonly archivedAt: string | null;
  readonly session: {
    readonly providerName: string | null;
    readonly status: string;
    readonly activeTurnId: string | null;
  } | null;
  readonly goalSummary?: { readonly status: string } | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly subagents?: ReadonlyArray<unknown> | undefined;
  readonly latestTurn: { readonly state: string } | null;
}

export interface ManagedGoalReconciliationCandidate {
  readonly id: ThreadId;
  readonly goalSummary?: { readonly status: string } | null | undefined;
}

export function activeManagedGoalThreadIds(
  threads: ReadonlyArray<ManagedGoalReconciliationCandidate>,
): ReadonlyArray<ThreadId> {
  return threads
    .filter((thread) => thread.goalSummary?.status === "active")
    .map((thread) => thread.id);
}

export function shouldContinueManagedGoal(shell: ManagedGoalContinuationCandidate): boolean {
  return (
    shell.archivedAt === null &&
    shell.session !== null &&
    MANAGED_GOAL_PROVIDERS.has(shell.session.providerName ?? "") &&
    (shell.session.status === "ready" || shell.session.status === "stopped") &&
    shell.session.activeTurnId === null &&
    shell.goalSummary?.status === "active" &&
    !shell.hasPendingApprovals &&
    !shell.hasPendingUserInput &&
    (shell.subagents?.length ?? 0) === 0 &&
    shell.latestTurn?.state !== "running"
  );
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;

  const continueGoal = Effect.fn("continueManagedGoal")(function* (threadId: ThreadId) {
    yield* Effect.sleep(CONTINUATION_DELAY);
    const shellOption = yield* projections.getThreadShellById(threadId);
    if (Option.isNone(shellOption)) return;
    const shell = shellOption.value;
    if (!shouldContinueManagedGoal(shell)) return;
    const detailOption = yield* projections.getThreadDetailById(threadId);
    if (Option.isNone(detailOption)) return;
    const thread = detailOption.value;
    const goal = thread.goal;
    if (!goal) return;
    if (goal.status !== "active") return;

    const continuationKey = [
      thread.id,
      goal.updatedAt,
      thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? "initial",
    ].join(":");
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`managed-goal:continue:${continuationKey}`),
      threadId,
      message: {
        messageId: MessageId.make(`managed-goal-message:${continuationKey}`),
        role: "user",
        authoredBy: "system",
        text: `Continue working toward the active goal:\n\n${goal.objective}\n\nReview current attached-agent work and any background results. Continue autonomously. Call goal_complete after verification or goal_blocked only if further autonomous progress is impossible.`,
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt,
    });
  });

  const processSafely = (threadId: ThreadId) =>
    continueGoal(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("managed goal continuation failed", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  const worker = yield* makeDrainableWorker(processSafely);

  const reconcileActiveGoals = Effect.fn("reconcileActiveManagedGoals")(function* () {
    const snapshot = yield* projections.getShellSnapshot();
    yield* Effect.forEach(activeManagedGoalThreadIds(snapshot.threads), worker.enqueue, {
      discard: true,
    });
  });

  const reconcileActiveGoalsSafely = reconcileActiveGoals().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("managed goal reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const start: GoalContinuationReactorShape["start"] = Effect.fn("startGoalContinuationReactor")(
    function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.type !== "thread.session-set" || event.payload.session.status !== "ready") {
            return Effect.void;
          }
          return worker.enqueue(event.payload.threadId);
        }),
      );

      // PubSub delivery is intentionally the fast path. The bounded poll is a
      // durability backstop for a ready transition that happens before the
      // subscription is established, while the process is restarting, or
      // while a provider compaction races its terminal session update. The
      // continuation command key is deterministic, so repeated reconciliation
      // cannot create duplicate turns.
      yield* Effect.forkScoped(
        Effect.sleep(RECONCILIATION_INTERVAL).pipe(
          Effect.andThen(reconcileActiveGoalsSafely),
          Effect.forever,
        ),
      );
      yield* reconcileActiveGoalsSafely;
    },
  );

  return { start, drain: worker.drain } satisfies GoalContinuationReactorShape;
});

export const GoalContinuationReactorLive = Layer.effect(GoalContinuationReactor, make);
