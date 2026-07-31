import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadListV2Items,
  resolveThreadListV2Status,
  sortThreadsForListV2,
} from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const NOW = "2026-06-02T00:00:00.000Z";

describe("resolveThreadListV2Status", () => {
  it("prioritizes approval over a running session", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      hasPendingApprovals: true,
      session: {
        threadId: ThreadId.make("t"),
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("approval");
  });

  it("resolves ready for quiescent threads", () => {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make("t"), title: "t" }))).toBe(
      "ready",
    );
  });
});

describe("sortThreadsForListV2", () => {
  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForListV2([
      { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("buildThreadListV2Items", () => {
  it("always includes threads from every machine", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          title: "Remote",
        }),
      ],
      searchQuery: "",
    });

    expect(items.map((item) => item.thread.environmentId)).toEqual([
      environmentId,
      remoteEnvironmentId,
    ]);
  });

  it("keeps every unarchived thread in one block, newest created first", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older-created"),
          title: "Older",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: NOW, // recent activity must NOT promote it
        }),
        makeThread({
          id: ThreadId.make("newer-created"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      searchQuery: "",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["newer-created", "older-created"]);
    expect(items.map((item) => item.isLast)).toEqual([false, true]);
  });

  it("filters by search query", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("match"), title: "Fix login bug" }),
        makeThread({ id: ThreadId.make("miss"), title: "Greeting" }),
      ],
      searchQuery: "login",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["match"]);
  });

  it("scopes the flat list to one project", () => {
    const otherProjectId = ProjectId.make("project-2");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("included"), title: "Included" }),
        makeThread({
          id: ThreadId.make("excluded"),
          projectId: otherProjectId,
          title: "Excluded",
        }),
      ],
      projectRefs: [{ environmentId, projectId: ProjectId.make("project-1") }],
      searchQuery: "",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["included"]);
  });

  it("scopes the flat list to every environment member of a logical project", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          title: "Remote",
        }),
      ],
      projectRefs: [
        { environmentId, projectId: ProjectId.make("project-1") },
        { environmentId: remoteEnvironmentId, projectId: ProjectId.make("project-1") },
      ],
      searchQuery: "",
    });

    expect(items.map((item) => item.thread.id)).toEqual(["local", "remote"]);
  });
});

describe("live subagents", () => {
  const agent = (taskId: string, overrides = {}) => ({
    taskId,
    toolUseId: `toolu_${taskId}`,
    description: `Agent ${taskId}`,
    subagentType: null,
    status: "running" as const,
    isBackgrounded: false,
    lastToolName: null,
    totalTokens: null,
    startedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  });

  it("reports agents running while the thread's own session is idle", () => {
    // The case the whole feature exists for: a backgrounded subagent outlives
    // the turn that spawned it, so the session reads ready while work
    // continues. Without this the row would say the thread is finished.
    const status = resolveThreadListV2Status(
      makeThread({ id: ThreadId.make("t"), title: "t", subagents: [agent("a")] }),
    );

    expect(status).toBe("agents");
  });

  it("still says working when the main agent is running too", () => {
    // "Working" already says the thread is busy; the child rows say who.
    const status = resolveThreadListV2Status(
      makeThread({
        id: ThreadId.make("t"),
        title: "t",
        subagents: [agent("a")],
        session: {
          threadId: ThreadId.make("t"),
          status: "running",
          providerName: "claude",
          providerInstanceId: ProviderInstanceId.make("claude"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    expect(status).toBe("working");
  });

  it("places each agent directly beneath the thread that spawned it", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("newer"),
          title: "Newer",
          createdAt: "2026-06-02T00:00:00.000Z",
          subagents: [agent("a1"), agent("a2")],
        }),
        makeThread({
          id: ThreadId.make("older"),
          title: "Older",
          createdAt: "2026-06-01T00:00:00.000Z",
        }),
      ],
      searchQuery: "",
    });

    expect(
      items.map((item) => (item.kind === "agent" ? `agent:${item.agent.taskId}` : item.thread.id)),
    ).toEqual(["newer", "agent:a1", "agent:a2", "older"]);
  });

  it("leaves a thread without agents exactly as it was", () => {
    // A list of quiet threads must not become a tree.
    const { items } = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("t"), title: "t" })],
      searchQuery: "",
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("thread");
  });

  it("marks the last row as last even when an agent is the tail", () => {
    // isLast drives the row's hairline; an agent tail would otherwise draw a
    // separator against nothing.
    const { items } = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("t"), title: "t", subagents: [agent("a1")] })],
      searchQuery: "",
    });

    expect(items.at(-1)?.kind).toBe("agent");
    expect(items.at(-1)?.isLast).toBe(true);
  });

  it("does not surface an agent whose thread was filtered out by search", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("hit"), title: "Keep", subagents: [agent("a1")] }),
        makeThread({ id: ThreadId.make("miss"), title: "Drop", subagents: [agent("a2")] }),
      ],
      searchQuery: "keep",
    });

    expect(
      items.map((item) => (item.kind === "agent" ? item.agent.taskId : item.thread.id)),
    ).toEqual(["hit", "a1"]);
  });
});
