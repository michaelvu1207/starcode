import { describe, expect, it } from "vite-plus/test";

import chatViewSource from "../ChatView.tsx?raw";
import historyMessageSource from "../history/HistoryMessage.tsx?raw";
import agentThreadViewSource from "./AgentThreadView.tsx?raw";
import messagesTimelineSource from "./MessagesTimeline.tsx?raw";
import threadHistorySource from "./ThreadHistorySection.tsx?raw";

describe("the read-only nested-agent thread surface", () => {
  it("renders the linked rollout directly without the old transcript accordion", () => {
    expect(agentThreadViewSource).toContain("<HistoryThreadTimeline");
    expect(agentThreadViewSource).not.toContain("<ThreadHistorySection");
    expect(agentThreadViewSource).not.toContain("Codex CLI transcript");
    expect(agentThreadViewSource).toContain('data-testid="agent-thread-reading-surface"');
    expect(threadHistorySource).toContain('data-testid="history-thread-timeline"');

    const linkedHistory = agentThreadViewSource.indexOf('agentRun.transcriptState === "linked"');
    expect(linkedHistory).toBeGreaterThan(-1);
    expect(agentThreadViewSource).toContain("provider: agentRun.provider");
    expect(agentThreadViewSource).toContain("Transcript discovery is in progress.");
    expect(agentThreadViewSource).toContain("Transcript unavailable.");
    expect(agentThreadViewSource).not.toContain("AgentActivityRow");
    expect(agentThreadViewSource).not.toContain("activities");
    expect(agentThreadViewSource).not.toContain("WrenchIcon");
  });

  it("shares ordinary thread message geometry with live and history rows", () => {
    expect(messagesTimelineSource).toContain('from "./ThreadMessageLayout"');
    expect(historyMessageSource).toContain('from "../chat/ThreadMessageLayout"');
    expect(agentThreadViewSource).toContain("max-w-3xl");
    expect(agentThreadViewSource).toContain("px-3 sm:px-5");
  });

  it("never reserves a top bar for agent identity or status", () => {
    expect(agentThreadViewSource).toContain('aria-label="Back to the main thread"');
    expect(agentThreadViewSource).not.toContain("agent-thread-context");
    expect(agentThreadViewSource).not.toContain("statusLabel");
    expect(agentThreadViewSource).not.toContain("threadModel");
    expect(agentThreadViewSource).not.toContain("task.model");
    expect(agentThreadViewSource).not.toContain("BotIcon");
    expect(agentThreadViewSource).not.toContain("PauseIcon");
    expect(agentThreadViewSource).not.toContain("<header");
    expect(agentThreadViewSource).not.toContain("max-h-[45vh]");

    const backControlStart = agentThreadViewSource.indexOf('data-testid="agent-thread-back"');
    const backControlEnd = agentThreadViewSource.indexOf("</button>", backControlStart);
    const backControl = agentThreadViewSource.slice(backControlStart, backControlEnd);
    expect(backControl).toContain("absolute");
    expect(backControl).toContain("top-1/2");
    expect(backControl).toContain("left-2");
    expect(backControl).toContain("-translate-y-1/2");
    expect(backControl).toContain("size-[var(--workspace-titlebar-control-size)]");
    expect(backControl).not.toContain("fixed");
    expect(backControl).not.toContain("shrink-0");
    expect(backControl).not.toContain("border");
    expect(backControl).not.toContain("bg-");
    expect(backControl).not.toContain(">Main thread");
    expect(backControl).not.toContain("workspace-controls-top");
    expect(backControl).not.toContain("workspace-topbar-height");
  });

  it("unmounts the composer while the read-only agent is open", () => {
    const composer = chatViewSource.indexOf('data-chat-composer-overlay="true"');
    const readOnlyGuard = chatViewSource.lastIndexOf("{selectedAgentRun ? null : (", composer);
    expect(composer).toBeGreaterThan(-1);
    expect(readOnlyGuard).toBeGreaterThan(-1);

    const parentPrelude = chatViewSource.indexOf("<ImportedThreadPrelude");
    const preludeGuard = chatViewSource.lastIndexOf("{selectedAgentRun ? null : (", parentPrelude);
    expect(parentPrelude).toBeGreaterThan(-1);
    expect(preludeGuard).toBeGreaterThan(-1);
  });
});
