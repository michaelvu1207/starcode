import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId, type AgentRun } from "@starcode/contracts";
import { SidebarAgentRow } from "./SidebarAgentRow";
import { SidebarFinishedAgentsRow } from "./SidebarFinishedAgentsRow";

const finishedAgent: AgentRun = {
  parentThreadId: ThreadId.make("parent"),
  provider: "codex",
  agentRunId: "agent-finished",
  launchToolUseId: "tool-finished",
  description: "Verify the deployment",
  taskType: "codex_cli",
  agentType: "reviewer",
  model: "gpt-5.6-sol",
  status: "completed",
  historySessionId: null,
  transcriptState: "unavailable",
  startedAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:01:00.000Z",
};

describe("SidebarFinishedAgentsRow", () => {
  it("renders the requested collapsed disclosure label", () => {
    const markup = renderToStaticMarkup(
      <SidebarFinishedAgentsRow isExpanded={false} onToggle={() => undefined} />,
    );

    expect(markup).toContain("View finished subagents");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-testid="sidebar-v2-finished-agents-row"');
  });

  it("exposes its expanded state", () => {
    const markup = renderToStaticMarkup(
      <SidebarFinishedAgentsRow isExpanded={true} onToggle={() => undefined} />,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("rotate-90");
  });

  it("renders finished history through the normal selectable agent row", () => {
    const markup = renderToStaticMarkup(
      <SidebarAgentRow agent={finishedAgent} isActive={true} onSelect={() => undefined} />,
    );

    expect(markup).toContain("Verify the deployment");
    expect(markup).toContain('data-testid="sidebar-v2-agent-row"');
    expect(markup).toContain('data-agent-run-id="agent-finished"');
    expect(markup).toContain('data-provider="codex"');
    expect(markup).toContain('data-status="completed"');
    expect(markup).toContain('data-transcript-state="unavailable"');
    expect(markup).toContain("reviewer");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain('aria-current="true"');
  });

  it("renders nested Pi attribution without creating a top-level thread row", () => {
    const markup = renderToStaticMarkup(
      <SidebarAgentRow
        agent={{
          ...finishedAgent,
          provider: "pi",
          taskType: "attached_agent",
          agentRunId: "agent:nested",
          parentAgentRunId: "agent:parent",
          description: "Nested Pi check",
        }}
        isActive={false}
        onSelect={() => undefined}
      />,
    );
    expect(markup).toContain('data-testid="sidebar-v2-agent-row"');
    expect(markup).toContain('data-parent-agent-run-id="agent:parent"');
    expect(markup).toContain("Child of agent:parent");
    expect(markup).toContain("Activity timeline available");
    expect(markup).not.toContain('data-testid="sidebar-v2-thread-row"');
  });
});
