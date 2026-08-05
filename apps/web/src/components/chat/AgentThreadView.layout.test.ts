import { describe, expect, it } from "vite-plus/test";

import chatViewSource from "../ChatView.tsx?raw";
import agentThreadViewSource from "./AgentThreadView.tsx?raw";

describe("the interactive nested Pi conversation surface", () => {
  it("uses the ordinary timeline and keeps the ordinary composer mounted", () => {
    const selectedBranch = chatViewSource.slice(
      chatViewSource.indexOf("<AgentThreadView onBack"),
      chatViewSource.indexOf("</AgentThreadView>") + "</AgentThreadView>".length,
    );
    expect(selectedBranch).toContain("<MessagesTimeline");
    expect(selectedBranch).toContain("selectedAgentTimelineEntries");
    expect(chatViewSource).toContain('data-chat-composer-overlay="true"');
    const composer = chatViewSource.indexOf('data-chat-composer-overlay="true"');
    const nearestSelectionGuard = chatViewSource.lastIndexOf(
      "{selectedAgentRun ? null : (",
      composer,
    );
    expect(nearestSelectionGuard).toBeLessThan(chatViewSource.indexOf("<AgentThreadView onBack"));
    expect(chatViewSource).toContain("startThreadAgentTurn");
    expect(chatViewSource).toContain("interruptThreadAgentTurn");
  });

  it("keeps only the back affordance as agent-specific chrome", () => {
    expect(agentThreadViewSource).toContain('aria-label="Back to the main thread"');
    expect(agentThreadViewSource).toContain("{children}");
    expect(agentThreadViewSource).not.toContain("ScrollArea");
    expect(agentThreadViewSource).not.toContain("deriveWorkLogEntries");
    expect(agentThreadViewSource).not.toContain("HistoryThreadTimeline");
  });
});
