import { describe, expect, it } from "vite-plus/test";

import { deriveLiveSubagents, type SubagentActivityRow } from "./threadSubagentSummary.ts";

const row = (
  kind: string,
  payload: Record<string, unknown>,
  createdAt = "2026-07-28T10:00:00.000Z",
): SubagentActivityRow => ({ kind, createdAt, payload });

describe("deriveLiveSubagents", () => {
  it("carries a started agent with the identity its opening event reported", () => {
    const live = deriveLiveSubagents([
      row("task.started", {
        taskId: "task-1",
        detail: "Review the auth module",
        subagentType: "code-reviewer",
        toolUseId: "toolu_01",
      }),
    ]);

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      taskId: "task-1",
      toolUseId: "toolu_01",
      description: "Review the auth module",
      subagentType: "code-reviewer",
      status: "running",
      isBackgrounded: false,
    });
  });

  it("keeps identity from the opening event when the newest one omits it", () => {
    // The bounded query hands the fold exactly two rows per task, and only the
    // first carries toolUseId. Losing it would leave the agent listable but its
    // transcript unreachable, which is the whole point of the row.
    const live = deriveLiveSubagents([
      row("task.started", {
        taskId: "task-1",
        detail: "Review the auth module",
        subagentType: "code-reviewer",
        toolUseId: "toolu_01",
      }),
      row("task.progress", {
        taskId: "task-1",
        title: "Review the auth module",
        lastToolName: "Grep",
        usage: { total_tokens: 4200 },
      }),
    ]);

    expect(live[0]?.toolUseId).toBe("toolu_01");
    expect(live[0]?.subagentType).toBe("code-reviewer");
    expect(live[0]?.lastToolName).toBe("Grep");
    expect(live[0]?.totalTokens).toBe(4200);
  });

  it("does not replace the launch description with live reasoning or tool output", () => {
    const live = deriveLiveSubagents([
      row("task.started", {
        taskId: "agent:traffic-lights",
        detail: "Replacement audit: traffic lights",
        subagentType: "pi agent · high effort",
      }),
      row("task.progress", {
        taskId: "agent:traffic-lights",
        title: '{"goal":null}',
        detail: 'Replacement audit: traffic lights · {"goal":null}',
      }),
    ]);

    expect(live[0]?.description).toBe("Replacement audit: traffic lights");
  });

  it("does not classify a background shell task as a live subagent", () => {
    const live = deriveLiveSubagents([
      row("task.started", {
        taskId: "bash-1",
        taskType: "local_bash",
        detail: "Start dev server",
      }),
      // Later lifecycle events commonly omit taskType. The opening event must
      // keep this task excluded for the rest of its lifetime.
      row("task.progress", {
        taskId: "bash-1",
        title: "Start dev server",
      }),
    ]);

    expect(live).toEqual([]);
  });

  it("replaces token totals rather than accumulating them", () => {
    // total_tokens is a running total for the task. Summing 117 progress
    // events for one subagent would report millions for a task that used
    // eighty thousand.
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-1", detail: "Work" }),
      row("task.progress", { taskId: "task-1", usage: { total_tokens: 1000 } }),
      row("task.progress", { taskId: "task-1", usage: { total_tokens: 2500 } }),
    ]);

    expect(live[0]?.totalTokens).toBe(2500);
  });

  it("drops an agent once it reaches a terminal event", () => {
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-1", detail: "Work" }),
      row("task.completed", { taskId: "task-1", status: "completed" }),
    ]);

    expect(live).toEqual([]);
  });

  it("drops a killed agent, which never reaches a terminal notification", () => {
    // A killed subagent gets no task.completed at all — without the patch it
    // would read as running forever.
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-1", detail: "Work" }),
      row("task.updated", { taskId: "task-1", status: "killed" }),
    ]);

    expect(live).toEqual([]);
  });

  it("keeps a paused agent, because it is still the user's to resume", () => {
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-1", detail: "Work" }),
      row("task.updated", { taskId: "task-1", status: "paused" }),
    ]);

    expect(live).toHaveLength(1);
    expect(live[0]?.status).toBe("paused");
  });

  it("reopens an agent when progress arrives after an out-of-order terminal", () => {
    // Progress is proof of life. The client's deriveSubagentTasks does the
    // same, and the two folds have to agree or a thread's sidebar row and its
    // own panel will disagree about what is running.
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-1", detail: "Work" }),
      row("task.completed", { taskId: "task-1", status: "completed" }),
      row("task.progress", { taskId: "task-1", lastToolName: "Bash" }),
    ]);

    expect(live).toHaveLength(1);
    expect(live[0]?.lastToolName).toBe("Bash");
  });

  it("records backgrounding, which is what makes an idle thread still busy", () => {
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-1", detail: "Work" }),
      row("task.updated", { taskId: "task-1", isBackgrounded: true }),
    ]);

    expect(live[0]?.isBackgrounded).toBe(true);
  });

  it("clears lastToolName on completion so no live subtitle outlives the work", () => {
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-a", detail: "A" }),
      row("task.progress", { taskId: "task-a", lastToolName: "Bash" }),
      row("task.completed", { taskId: "task-a", status: "completed" }),
      // A second agent keeps the list non-empty so the assertion has a subject.
      row("task.started", { taskId: "task-b", detail: "B" }),
    ]);

    expect(live.map((agent) => agent.taskId)).toEqual(["task-b"]);
  });

  it("keeps an agent whose description never arrived", () => {
    // A nameless agent still deserves a row; the client labels it from its
    // type. Dropping it would make the sidebar quietly under-report work.
    const live = deriveLiveSubagents([row("task.started", { taskId: "task-1" })]);

    expect(live).toHaveLength(1);
    expect(live[0]?.description).toBeNull();
  });

  it("ignores rows that carry no task id and non-task activity", () => {
    const live = deriveLiveSubagents([
      row("tool.started", { itemType: "command_execution" }),
      row("task.progress", { lastToolName: "Bash" }),
    ]);

    expect(live).toEqual([]);
  });

  it("preserves first-seen order so rows do not reshuffle as tokens tick up", () => {
    const live = deriveLiveSubagents([
      row("task.started", { taskId: "task-a", detail: "A" }),
      row("task.started", { taskId: "task-b", detail: "B" }),
      row("task.progress", { taskId: "task-a", usage: { total_tokens: 9999 } }),
    ]);

    expect(live.map((agent) => agent.taskId)).toEqual(["task-a", "task-b"]);
  });
});
