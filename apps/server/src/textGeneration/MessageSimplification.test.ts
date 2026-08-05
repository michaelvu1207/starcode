import { it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vite-plus/test";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  MESSAGE_SIMPLIFICATION_MODEL,
  MESSAGE_SIMPLIFICATION_REASONING_EFFORT,
  simplifyAssistantMessage,
} from "./MessageSimplification.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const messageId = MessageId.make("assistant-1");
const piInstanceId = ProviderInstanceId.make("pi-personal");

function makeThread(streaming = false): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    modelSelection: { instanceId: piInstanceId, model: "openai-codex/gpt-5.6-sol" },
    worktreePath: "/workspace/worktree",
    messages: [
      {
        id: messageId,
        role: "assistant",
        text: "Implemented the feature and verified the focused tests.",
        turnId: null,
        streaming,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    ],
  } as unknown as OrchestrationThread;
}

const project = {
  id: projectId,
  workspaceRoot: "/workspace/project",
} as OrchestrationProjectShell;

function makeProjection(thread: OrchestrationThread) {
  return {
    getThreadDetailById: () => Effect.succeed(Option.some(thread)),
    getProjectShellById: () => Effect.succeed(Option.some(project)),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
}

function makeRegistry(instance: ProviderInstance) {
  return {
    listInstances: Effect.succeed([instance]),
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
}

describe("simplifyAssistantMessage", () => {
  it.effect("uses the thread's Pi instance with GPT-5.6 Sol at low effort", () =>
    Effect.gen(function* () {
      const generateMessageSummary = vi.fn(() =>
        Effect.succeed({ summary: "Implemented and tested." }),
      );
      const instance = {
        instanceId: piInstanceId,
        driverKind: "pi",
        enabled: true,
        textGeneration: { generateMessageSummary },
      } as unknown as ProviderInstance;

      const result = yield* simplifyAssistantMessage({
        threadId,
        messageId,
        instructions: "Use one sentence.",
      }).pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          makeProjection(makeThread()),
        ),
        Effect.provideService(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          makeRegistry(instance),
        ),
      );

      expect(result).toEqual({ summary: "Implemented and tested." });
      expect(generateMessageSummary).toHaveBeenCalledWith({
        cwd: "/workspace/worktree",
        message: "Implemented the feature and verified the focused tests.",
        instructions: "Use one sentence.",
        modelSelection: {
          instanceId: piInstanceId,
          model: MESSAGE_SIMPLIFICATION_MODEL,
          options: [{ id: "effort", value: MESSAGE_SIMPLIFICATION_REASONING_EFFORT }],
        },
      });
    }),
  );

  it.effect("rejects an assistant message that is still streaming", () =>
    simplifyAssistantMessage({ threadId, messageId }).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        makeProjection(makeThread(true)),
      ),
      Effect.provideService(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        makeRegistry({} as ProviderInstance),
      ),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason).toBe("message_not_simplifiable");
        }),
      ),
    ),
  );
});
