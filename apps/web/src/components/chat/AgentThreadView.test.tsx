import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import AgentThreadView from "./AgentThreadView";

describe("AgentThreadView", () => {
  it("adds only a back affordance around the shared conversation surface", () => {
    const markup = renderToStaticMarkup(
      <AgentThreadView onBack={() => undefined}>
        <div data-testid="ordinary-messages-timeline">conversation</div>
      </AgentThreadView>,
    );

    expect(markup).toContain('data-testid="agent-thread-surface"');
    expect(markup).toContain('aria-label="Back to the main thread"');
    expect(markup).toContain('data-testid="ordinary-messages-timeline"');
    expect(markup).not.toContain("read-only");
    expect(markup).not.toContain("activity-card");
  });
});
