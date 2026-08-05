/**
 * Structural guardrails for Chats as a peer sidebar surface.
 *
 * The membership and ordering behavior is covered in `Sidebar.projects.test`.
 * These source assertions cover the composition boundary that a unit render
 * cannot reach without mounting the app's router, connection state, and
 * catalog: the header owns the switch, and Chats wins the whole list region.
 */
import { describe, expect, it } from "vite-plus/test";

import sidebarSource from "../SidebarV2.tsx?raw";
import headerSource from "./SidebarHeaderCompact.tsx?raw";
import projectsViewSource from "./SidebarProjectsView.tsx?raw";

describe("the sidebar Chats surface", () => {
  it("is selected from an accessible button in the compact icon bar", () => {
    expect(headerSource).toContain("<MessageCircleIcon");
    expect(headerSource).toContain('data-testid="sidebar-chats-toggle"');
    expect(headerSource).toContain("aria-pressed={showChats}");
    expect(headerSource).toContain('showChats ? "Show project list" : "Show chat list"');
    expect(headerSource).not.toContain("<SidebarTrigger");
    expect(headerSource).not.toContain('data-testid="command-palette-trigger"');
  });

  it("replaces the complete list before any normal grouping mode is chosen", () => {
    const chatsBranch = sidebarSource.indexOf("if (showChats)");
    const connectionsBranch = sidebarSource.indexOf('if (viewMode === "connections")');
    const projectsBranch = sidebarSource.indexOf('if (viewMode === "projects")');

    expect(chatsBranch).toBeGreaterThan(-1);
    expect(chatsBranch).toBeLessThan(connectionsBranch);
    expect(chatsBranch).toBeLessThan(projectsBranch);
    expect(sidebarSource).toContain('mode="chats"');
  });

  it("does not render Chats as a dock inside the Projects surface", () => {
    expect(projectsViewSource).toContain('if (props.mode === "chats") return renderChatsView();');
    expect(projectsViewSource).not.toContain("sc-chats-dock");
    expect(projectsViewSource).not.toContain("sidebar-v2-chats-panel");
    expect(projectsViewSource).not.toContain('import "./ChatsDock.css"');
  });
});
