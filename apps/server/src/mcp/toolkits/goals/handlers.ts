import { CommandId, EventId, GoalToolError, type ThreadGoal } from "@starcode/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GoalsToolkit } from "./tools.ts";

type Operation = "get" | "progress" | "complete" | "blocked";

const goalOperations = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const read = Effect.fnUntraced(function* (operation: Operation) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* projections.getThreadDetailById(invocation.threadId).pipe(
      Effect.mapError(
        () =>
          new GoalToolError({
            operation,
            reason: "storage_failed",
            detail: "The current thread could not be read.",
          }),
      ),
    );
    if (Option.isNone(thread)) {
      return yield* new GoalToolError({
        operation,
        reason: "storage_failed",
        detail: "The current thread could not be read.",
      });
    }
    return { invocation, thread: thread.value, goal: thread.value.goal ?? null };
  });

  const update = Effect.fnUntraced(function* (
    operation: Exclude<Operation, "get">,
    detail: string | undefined,
    status?: ThreadGoal["status"],
  ) {
    const current = yield* read(operation);
    if (!current.goal) {
      return yield* new GoalToolError({
        operation,
        reason: "goal_not_found",
        detail: "This thread has no managed goal.",
      });
    }
    if (current.goal.status !== "active") {
      return yield* new GoalToolError({
        operation,
        reason: "goal_terminal",
        detail: `The goal is already ${current.goal.status}.`,
      });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const goal = { ...current.goal, ...(status ? { status } : {}), updatedAt: now };
    if (status) {
      yield* engine
        .dispatch({
          type: "thread.goal.sync",
          commandId: CommandId.make(
            `mcp:goal:${operation}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: current.invocation.threadId,
          goal,
          observedAt: now,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(
            () =>
              new GoalToolError({
                operation,
                reason: "storage_failed",
                detail: "The goal update could not be persisted.",
              }),
          ),
        );
    }
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `mcp:goal-activity:${operation}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        threadId: current.invocation.threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          tone: "info",
          kind: `goal.${operation}`,
          summary:
            detail ??
            (operation === "complete"
              ? "Goal completed"
              : operation === "blocked"
                ? "Goal blocked"
                : "Goal progress recorded"),
          payload: detail ? { detail } : {},
          turnId: current.thread.latestTurn?.turnId ?? null,
          createdAt: now,
        },
        createdAt: now,
      })
      .pipe(
        Effect.mapError(
          () =>
            new GoalToolError({
              operation,
              reason: "storage_failed",
              detail: "The goal activity could not be persisted.",
            }),
        ),
      );
    return { goal };
  });

  return {
    goal_get: () => read("get").pipe(Effect.map(({ goal }) => ({ goal }))),
    goal_progress: ({ detail }: { readonly detail: string }) => update("progress", detail),
    goal_complete: ({ detail }: { readonly detail?: string | undefined }) =>
      update("complete", detail, "complete"),
    goal_blocked: ({ detail }: { readonly detail?: string | undefined }) =>
      update("blocked", detail, "blocked"),
  } satisfies Parameters<typeof GoalsToolkit.toLayer>[0];
});

export const GoalsToolkitHandlersLive = GoalsToolkit.toLayer(goalOperations);
