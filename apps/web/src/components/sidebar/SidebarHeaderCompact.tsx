/**
 * Fork-owned compact sidebar header.
 *
 * Upstream stacks three rows above the thread list: the brand row, a
 * full-width "Search ⌘K" bar with the compose button beside it, and the
 * "All projects" picker with the view menu and new-project button. Two of the
 * three rows spend a full row of sidebar height on controls that are one click
 * each, and the project picker is dead weight at our project count.
 *
 * This collapses all three into the brand row: title left, actions right. The
 * actions are the same actions — the search overlay is still the command
 * dialog ⌘K opens, new thread is still `handleNewThreadClick`, new project is
 * still the add-project command palette — so nothing here owns behaviour, only
 * placement. Fork-owned so the diff inside `SidebarV2.tsx` stays a call site.
 *
 * The project *filter* the picker used to drive is guarded separately; see
 * `sidebarProjectScope.ts`.
 */
import { useAtomValue } from "@effect/atom-react";
import { FolderPlusIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { CommandDialogTrigger } from "../ui/command";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarChromeHeader } from "./SidebarChrome";
import { SidebarV2ViewMenu } from "./SidebarV2ViewMenu";

/**
 * Sidebar-row styling from the buttons this header replaces, at the 28px
 * (`size="sm"`, h-7) box the workspace topbar's own controls use — the header
 * sits in the topbar row, and 32px boxes crowd the wordmark at 256px.
 */
const HEADER_ACTION_BUTTON_CLASS =
  "relative size-7 shrink-0 justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";

const HEADER_ACTION_ICON_CLASS = "size-4 shrink-0 text-sidebar-muted-foreground/80";

/**
 * Coarse pointers get a 48px hit area without growing the 28px button — the
 * same overlay the buttons upstream carry.
 */
function TouchTarget() {
  return (
    <span
      className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
      aria-hidden="true"
    />
  );
}

export const SidebarHeaderCompact = memo(function SidebarHeaderCompact({
  onNewThread,
  newThreadDisabled,
  onNewProject,
  showProjectActions,
}: {
  onNewThread: () => void;
  newThreadDisabled: boolean;
  onNewProject: () => void;
  /** False until at least one project exists — matches the old row-3 gate. */
  showProjectActions: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const searchShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  // Same resolution as the row it replaces: prefer the local-thread binding,
  // fall back to chat.new, no platform gating.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal") ??
    shortcutLabelForCommand(keybindings, "chat.new");

  return (
    <SidebarChromeHeader
      isElectron={isElectron}
      actions={
        <div className="relative z-10 ml-auto flex shrink-0 items-center gap-0.5 pr-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <CommandDialogTrigger
                  render={
                    <SidebarMenuButton
                      size="sm"
                      type="button"
                      aria-label="Search threads and commands"
                      className={HEADER_ACTION_BUTTON_CLASS}
                      data-testid="command-palette-trigger"
                    />
                  }
                />
              }
            >
              <SearchIcon className={HEADER_ACTION_ICON_CLASS} />
              <TouchTarget />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {searchShortcutLabel ? `Search (${searchShortcutLabel})` : "Search"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  type="button"
                  className={HEADER_ACTION_BUTTON_CLASS}
                  onClick={onNewThread}
                  disabled={newThreadDisabled}
                  aria-label="New thread"
                  data-testid="sidebar-new-thread"
                />
              }
            >
              <SquarePenIcon className={HEADER_ACTION_ICON_CLASS} />
              <TouchTarget />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
            </TooltipPopup>
          </Tooltip>
          {showProjectActions ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      size="sm"
                      type="button"
                      className={HEADER_ACTION_BUTTON_CLASS}
                      onClick={onNewProject}
                      aria-label="New project"
                      data-testid="sidebar-new-project"
                    />
                  }
                >
                  <FolderPlusIcon className={HEADER_ACTION_ICON_CLASS} />
                  <TouchTarget />
                </TooltipTrigger>
                <TooltipPopup side="bottom">New project</TooltipPopup>
              </Tooltip>
              <SidebarV2ViewMenu />
            </>
          ) : null}
        </div>
      }
    />
  );
});
