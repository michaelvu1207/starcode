import type { ContextMenuItem, ProjectCategorySlug } from "@starcode/contracts";

import type { OpenInSplitState } from "../split/openInSplit";

export const MOVE_THREAD_CONTEXT_ACTION_PREFIX = "move-to-project:";

export interface ThreadContextProjectTarget {
  readonly slug: ProjectCategorySlug;
  readonly title: string;
  readonly isCurrent: boolean;
}

export function buildSidebarThreadContextMenuItems(input: {
  readonly branch: string | null;
  readonly splitState: OpenInSplitState;
  readonly carriesConversation: boolean;
  readonly projectTargets: readonly ThreadContextProjectTarget[];
  readonly canRemoveFromProject: boolean;
}): readonly ContextMenuItem<string>[] {
  const items: ContextMenuItem<string>[] = [];

  if (input.splitState !== "hidden") {
    items.push({
      id: "open-in-split",
      label:
        input.splitState === "ready"
          ? "Open in split view"
          : input.splitState === "already-primary"
            ? "Already open here"
            : "Already in split view",
      disabled: input.splitState !== "ready",
    });
  }

  items.push({ id: "rename", label: "Rename thread" });

  if (input.projectTargets.length > 0 || input.canRemoveFromProject) {
    const children: ContextMenuItem<string>[] = [];
    if (input.canRemoveFromProject) {
      children.push({ id: "move-to-chats", label: "Remove from project" });
    }
    children.push(
      ...input.projectTargets.map((project) => ({
        id: `${MOVE_THREAD_CONTEXT_ACTION_PREFIX}${project.slug}`,
        label: project.title,
        disabled: project.isCurrent,
      })),
    );
    items.push({ id: "move-to-project", label: "Move to project", children });
  }

  items.push({
    id: "fork",
    label: input.carriesConversation ? "Fork with conversation" : "Fork thread (setup only)",
  });
  if (input.branch) {
    items.push({ id: "new-thread-on-branch", label: `New thread on ${input.branch}` });
  }
  items.push(
    { id: "mark-unread", label: "Mark unread" },
    { id: "archive", label: "Archive" },
    { id: "delete", label: "Delete", destructive: true, icon: "trash" },
  );
  return items;
}

export function threadContextMoveTarget(action: string): ProjectCategorySlug | null | undefined {
  if (action === "move-to-chats") return null;
  if (!action.startsWith(MOVE_THREAD_CONTEXT_ACTION_PREFIX)) return undefined;
  return action.slice(MOVE_THREAD_CONTEXT_ACTION_PREFIX.length) as ProjectCategorySlug;
}
