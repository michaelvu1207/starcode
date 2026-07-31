/**
 * Structural guardrails for the headerless chat pane.
 *
 * ChatView has enough stateful dependencies that a browserless render would
 * obscure the layout contract behind setup. These source assertions cover the
 * flex-positioning relationship that matters here: the transcript starts at
 * the pane's top edge while Electron retains an overlaid window drag surface.
 */
import { describe, expect, it } from "vite-plus/test";

import chatViewSource from "./ChatView.tsx?raw";
import appSidebarLayoutSource from "./AppSidebarLayout.tsx?raw";

const chatColumnStart = chatViewSource.indexOf("data-chat-column-maximized-away=");
const chatColumnOpening = chatViewSource.slice(
  chatViewSource.lastIndexOf("<div", chatColumnStart),
  chatColumnStart,
);
const titlebarBandStart = chatViewSource.indexOf("data-chat-titlebar-band");
const titlebarBand = chatViewSource.slice(
  chatViewSource.lastIndexOf("<div", titlebarBandStart),
  chatViewSource.indexOf("/>", titlebarBandStart),
);

describe("the headerless chat pane", () => {
  it("positions the desktop drag band over content instead of before it", () => {
    expect(chatColumnOpening).toContain('"relative flex min-h-0');
    expect(titlebarBand).toContain("workspace-topbar drag-region absolute inset-x-0 top-0 z-10");
    expect(titlebarBand).not.toContain("shrink-0");
  });

  it("keeps the collapsed-sidebar and native-control clearances on the overlay", () => {
    expect(titlebarBand).toContain("COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS");
    expect(titlebarBand).toContain("wco:pr-[var(--workspace-native-controls-inset)]");
  });

  it("overlays matching sidebar controls at the thread pane edges", () => {
    expect(appSidebarLayoutSource).toContain('data-sidebar-control-position="thread-pane"');
    expect(appSidebarLayoutSource).toContain('"calc(var(--sidebar-width) + 0.75rem)"');
    expect(appSidebarLayoutSource).toContain(
      'aria-label={isSidebarVisible ? "Hide sidebar" : "Show sidebar"}',
    );

    expect(chatViewSource).toContain('data-testid="thread-right-panel-toggle"');
    expect(chatViewSource).toContain(
      "props.suppressRightPanel !== true && !(shouldUsePlanSidebarSheet && rightPanelOpen)",
    );
    expect(chatViewSource).toContain("pressed={rightPanelOpen}");
    expect(chatViewSource).toContain("onPressedChange={toggleRightPanel}");
    expect(chatViewSource).toContain(
      'className="pointer-events-none absolute right-[var(--workspace-controls-right)]',
    );
  });
});
