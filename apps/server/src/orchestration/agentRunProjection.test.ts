import { ThreadId } from "@starcode/contracts";
import { assert, describe, it } from "@effect/vitest";

import { projectAgentRunActivity } from "./agentRunProjection.ts";

describe("projectAgentRunActivity", () => {
  const parentThreadId = ThreadId.make("parent-thread");
  const startedAt = "2026-07-30T20:00:00.000Z";

  it("excludes background Bash jobs even when they use the task lifecycle", () => {
    assert.isNull(
      projectAgentRunActivity({
        parentThreadId,
        kind: "task.started",
        createdAt: startedAt,
        payload: {
          taskId: "bash-job",
          taskType: "local_bash",
          title: "Build package",
        },
        existing: null,
      }),
    );
  });

  it("projects one Claude agent owned by its parent thread", () => {
    const run = projectAgentRunActivity({
      parentThreadId,
      kind: "task.started",
      createdAt: startedAt,
      payload: {
        taskId: "agent-1",
        taskType: "local_agent",
        subagentType: "Explore",
        toolUseId: "tool-1",
        parentNativeSessionId: "native-parent",
      },
      existing: null,
    });

    assert.deepEqual(run, {
      parentThreadId,
      provider: "claude",
      agentRunId: "agent-1",
      launchToolUseId: "tool-1",
      taskType: "local_agent",
      agentType: "Explore",
      model: null,
      description: null,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      historySessionId: null,
      transcriptState: "pending",
      parentNativeSessionId: "native-parent",
    });
  });

  it("keeps Codex as the logical provider across terminal lifecycle events", () => {
    const started = projectAgentRunActivity({
      parentThreadId,
      kind: "task.started",
      createdAt: startedAt,
      payload: {
        taskId: "codex-cli:tool-2",
        taskType: "codex_cli",
        toolUseId: "tool-2",
      },
      existing: null,
    });
    assert.isNotNull(started);

    const completed = projectAgentRunActivity({
      parentThreadId,
      kind: "task.completed",
      createdAt: "2026-07-30T20:01:00.000Z",
      payload: {
        taskId: "codex-cli:tool-2",
        status: "completed",
      },
      existing: started,
    });

    assert.equal(completed?.provider, "codex");
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.launchToolUseId, "tool-2");
  });
});
