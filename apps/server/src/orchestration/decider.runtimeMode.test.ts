/**
 * What a dispatched command is allowed to say about permissions.
 *
 * Fork-owned, and its own file because the shape it pins is easy to break from
 * either side: `thread.create` carries a runtime mode with no schema default,
 * so a caller that names one has named it deliberately and the decider must not
 * substitute anything for it. `thread.turn.start` carries one too, and there
 * the thread's stored mode wins — a turn is not a place to change permissions,
 * and the field has a decoding default, so honouring it would let a client that
 * simply omitted the field silently escalate a supervised thread. The two rules
 * read as inconsistent unless both are written down, which is why they are
 * tested together.
 *
 * @module deciderRuntimeModeTest
 */
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const readModel = (thread: OrchestrationThread | null): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: PROJECT_ID,
      title: "alpha",
      workspaceRoot: "/work/alpha",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    } as unknown as OrchestrationReadModel["projects"][number],
  ],
  threads: thread === null ? [] : [thread],
  updatedAt: NOW,
});

const existingThread = (runtimeMode: RuntimeMode): OrchestrationThread =>
  ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  }) as unknown as OrchestrationThread;

it.layer(NodeServices.layer)("dispatched runtime mode", (it) => {
  // Both modes, so the test cannot pass by agreeing with whatever the app-wide
  // default happens to be.
  for (const requested of ["full-access", "approval-required"] as const) {
    it.effect(`thread.create records the mode the caller asked for: ${requested}`, () =>
      Effect.gen(function* () {
        const decided = yield* decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-create"),
            threadId: THREAD_ID,
            projectId: PROJECT_ID,
            title: "Imported session",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5",
            },
            runtimeMode: requested,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          },
          readModel: readModel(null),
        });

        const events = Array.isArray(decided) ? decided : [decided];
        const created = events.find((event) => event.type === "thread.created");
        expect(created?.type).toBe("thread.created");
        if (created?.type !== "thread.created") return;
        expect(created.payload.runtimeMode).toBe(requested);
      }),
    );
  }

  it.effect("thread.turn.start runs the thread's mode, not the command's", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("msg-1"),
            role: "user",
            text: "go",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: readModel(existingThread("approval-required")),
      });

      const events = Array.isArray(decided) ? decided : [decided];
      const requested = events.find((event) => event.type === "thread.turn-start-requested");
      expect(requested?.type).toBe("thread.turn-start-requested");
      if (requested?.type !== "thread.turn-start-requested") return;
      // Raising a thread's permissions is `thread.runtime-mode.set`, which is
      // what the composer sends before the turn when the two disagree.
      expect(requested.payload.runtimeMode).toBe("approval-required");
    }),
  );
});
