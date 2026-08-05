import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@starcode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-08-01T00:00:00.000Z";
const parentThreadId = ThreadId.make("parent");

function readModel(
  provider: "pi" | "codex" = "pi",
  taskType: string = "attached_agent",
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: ProjectId.make("project"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: parentThreadId,
        projectId: ProjectId.make("project"),
        title: "Parent",
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        agentRuns: [
          {
            parentThreadId,
            provider,
            providerInstanceId: ProviderInstanceId.make(provider),
            agentRunId: "agent:child",
            parentAgentRunId: null,
            launchToolUseId: "agent:child",
            taskType,
            agentType: "Pi agent",
            model: "gpt-5.6-sol",
            description: "Child",
            status: "paused",
            startedAt: now,
            updatedAt: now,
            historySessionId: null,
            transcriptState: "pending",
          },
        ],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

it.layer(NodeServices.layer)("nested AgentRun decider", (it) => {
  it.effect("emits only an addressed nested turn intent", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: {
          type: "thread.agent.turn.start",
          commandId: CommandId.make("cmd-agent-turn"),
          threadId: parentThreadId,
          agentRunId: "agent:child",
          message: { messageId: MessageId.make("message-agent"), role: "user", text: "continue" },
          createdAt: now,
        },
      });
      expect(Array.isArray(event)).toBe(false);
      expect(event).toMatchObject({
        type: "thread.agent-turn-start-requested",
        payload: {
          threadId: parentThreadId,
          agentRunId: "agent:child",
          messageId: "message-agent",
          text: "continue",
        },
      });
    }),
  );

  it.effect("rejects a non-Pi AgentRun", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: readModel("codex"),
          command: {
            type: "thread.agent.turn.interrupt",
            commandId: CommandId.make("cmd-agent-interrupt"),
            threadId: parentThreadId,
            agentRunId: "agent:child",
            createdAt: now,
          },
        }),
      );
      expect(error.message).toContain("Interactive Pi AgentRun");
    }),
  );

  it.effect("rejects a separate top-level Pi task masquerading as an AgentRun", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel: readModel("pi", "separate_task"),
          command: {
            type: "thread.agent.turn.start",
            commandId: CommandId.make("cmd-agent-turn"),
            threadId: parentThreadId,
            agentRunId: "agent:child",
            message: { messageId: MessageId.make("message-agent"), role: "user", text: "continue" },
            createdAt: now,
          },
        }),
      );
      expect(error.message).toContain("not an interactive Pi AgentRun");
    }),
  );
});
