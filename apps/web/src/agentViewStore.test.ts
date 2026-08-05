import { EnvironmentId, ThreadId } from "@starcode/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useAgentViewStore } from "./agentViewStore";

const environmentId = EnvironmentId.make("environment-local");
const firstThread = { environmentId, threadId: ThreadId.make("thread-1") };
const secondThread = { environmentId, threadId: ThreadId.make("thread-2") };

afterEach(() => {
  useAgentViewStore.setState({ selectedAgentRunByThreadKey: {} });
});

describe("agentViewStore", () => {
  it("scopes selection to the parent thread", () => {
    useAgentViewStore.getState().select(firstThread, {
      provider: "claude",
      agentRunId: "agent-1",
    });
    useAgentViewStore.getState().select(secondThread, {
      provider: "codex",
      agentRunId: "agent-2",
    });

    expect(Object.values(useAgentViewStore.getState().selectedAgentRunByThreadKey)).toEqual([
      { provider: "claude", agentRunId: "agent-1" },
      { provider: "codex", agentRunId: "agent-2" },
    ]);
  });

  it("retains provider identity when two agents reuse an id", () => {
    useAgentViewStore.getState().select(firstThread, {
      provider: "claude",
      agentRunId: "shared",
    });
    useAgentViewStore.getState().select(firstThread, {
      provider: "codex",
      agentRunId: "shared",
    });

    expect(Object.values(useAgentViewStore.getState().selectedAgentRunByThreadKey)).toEqual([
      { provider: "codex", agentRunId: "shared" },
    ]);
  });

  it("clears only the requested parent", () => {
    useAgentViewStore.getState().select(firstThread, {
      provider: "claude",
      agentRunId: "agent-1",
    });
    useAgentViewStore.getState().select(secondThread, {
      provider: "codex",
      agentRunId: "agent-2",
    });

    useAgentViewStore.getState().clear(firstThread);

    expect(Object.values(useAgentViewStore.getState().selectedAgentRunByThreadKey)).toEqual([
      { provider: "codex", agentRunId: "agent-2" },
    ]);
  });
});
