import { ProjectCategorySlug } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarThreadContextMenuItems,
  threadContextMoveTarget,
} from "./SidebarThreadContextMenu";
import sidebarSource from "../SidebarV2.tsx?raw";

const project = (slug: string, title: string, isCurrent = false) => ({
  slug: ProjectCategorySlug.make(slug),
  title,
  isCurrent,
});

describe("buildSidebarThreadContextMenuItems", () => {
  it("moves the overflow actions into the row context menu", () => {
    const items = buildSidebarThreadContextMenuItems({
      branch: "feature/sidebar",
      splitState: "ready",
      carriesConversation: true,
      canRemoveFromProject: true,
      projectTargets: [project("design", "Design"), project("active", "Active", true)],
    });

    expect(items).toEqual(
      expect.arrayContaining([
        { id: "open-in-split", label: "Open in split view", disabled: false },
        { id: "rename", label: "Rename thread" },
        { id: "fork", label: "Fork with conversation" },
        { id: "archive", label: "Archive" },
        { id: "mark-unread", label: "Mark unread" },
        { id: "delete", label: "Delete", destructive: true, icon: "trash" },
      ]),
    );
    expect(items.find((item) => item.id === "move-to-project")?.children).toEqual([
      { id: "move-to-chats", label: "Remove from project" },
      { id: "move-to-project:design", label: "Design", disabled: false },
      { id: "move-to-project:active", label: "Active", disabled: true },
    ]);
  });

  it("explains unavailable split placement and a setup-only fork", () => {
    const items = buildSidebarThreadContextMenuItems({
      branch: null,
      splitState: "already-primary",
      carriesConversation: false,
      canRemoveFromProject: false,
      projectTargets: [],
    });

    expect(items).toContainEqual({
      id: "open-in-split",
      label: "Already open here",
      disabled: true,
    });
    expect(items).toContainEqual({ id: "fork", label: "Fork thread (setup only)" });
    expect(items.some((item) => item.id === "move-to-project")).toBe(false);
    expect(items.some((item) => item.id === "new-thread-on-branch")).toBe(false);
  });
});

describe("threadContextMoveTarget", () => {
  it("distinguishes unfiling, filing, and unrelated actions", () => {
    expect(threadContextMoveTarget("move-to-chats")).toBe(null);
    expect(threadContextMoveTarget("move-to-project:design")).toBe("design");
    expect(threadContextMoveTarget("archive")).toBeUndefined();
  });
});

describe("SidebarV2 context-menu access", () => {
  it("keeps the row action list reachable from the keyboard", () => {
    expect(sidebarSource).toContain('event.key === "ContextMenu"');
    expect(sidebarSource).toContain('event.key === "F10" && event.shiftKey');
  });
});
