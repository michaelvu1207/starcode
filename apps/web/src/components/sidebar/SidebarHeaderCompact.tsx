/**
 * Fork-owned compact sidebar header.
 *
 * Upstream stacks three rows above the thread list: the brand row, a
 * full-width command bar with the compose button beside it, and the
 * "All projects" picker with the view menu and new-project button. Two of the
 * three rows spend a full row of sidebar height on controls that are one click
 * each, and the project picker is dead weight at our project count.
 *
 * This collapses all three into two: the wordmark on its own row, and one
 * compact icon strip beneath it. The new-project action is still the
 * add-project command palette, so nothing here owns behaviour, only placement.
 * Fork-owned so the diff inside `SidebarV2.tsx` stays a call site.
 *
 * Two icons that were here are not any more. **New thread** left because the
 * strip was never its only door: the `chat.newLocal` binding is handled at the
 * route (`_chat.tsx`), the command palette offers it with a project submenu,
 * and every project group carries its own `+` — which is the one that already
 * says *which* project the thread lands in, the question this button had to
 * guess at. **Workbench** left because the thing it pointed at should not
 * exist: a workbench belongs to a project, and each project has its own on its
 * home view. The fleet-wide `/workbench` route is still routable by URL and no
 * longer linked from anywhere.
 *
 * Three icons arrived. **Chats** swaps the project/thread surface for loose
 * conversations without asking them to compete for space at the bottom of the
 * project list. **Archive** replaces the active list with restorable archived
 * threads. **Settings** was a full-width labelled row at the foot of the sidebar;
 * moving it here lets `SidebarChromeFooter` collapse on the common case where
 * neither update pill has anything to say.
 *
 * **Chats** leads the strip because it changes the sidebar's primary surface.
 * The sidebar collapse control moved out of this strip and into the top-left
 * corner of the thread pane, where the same button can both hide and restore
 * the sidebar. See `AppSidebarLayout.SidebarControl`.
 *
 * The project *filter* the picker used to drive is guarded separately; see
 * `sidebarProjectScope.ts`.
 */
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, MessageCircleIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { SidebarMenuButton, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarChromeHeader } from "./SidebarChrome";
import { SidebarConnectionsMenu } from "./SidebarConnectionsMenu";
import { SidebarProjectsMenu } from "./SidebarProjectsMenu";
import { SidebarV2ViewMenu } from "./SidebarV2ViewMenu";

/**
 * Sidebar-row styling from the buttons this header replaces, at the 28px
 * (`size="sm"`, h-7) box the workspace topbar's own controls use. The strip has
 * its own row now and no longer competes with the wordmark for width, but the
 * size holds: these are secondary controls, and growing them only to fill space
 * would make them louder than the thread list they sit above.
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
  onNewProject,
  showProjectActions,
  showChats,
  onToggleChats,
  showArchived,
  onToggleArchived,
}: {
  onNewProject: () => void;
  /** False until at least one project exists — matches the old row-3 gate. */
  showProjectActions: boolean;
  /** Chats is a peer sidebar surface, not a panel attached below Projects. */
  showChats: boolean;
  onToggleChats: () => void;
  /** Archived tasks replace every active task surface while selected. */
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // Carried over verbatim from the footer row this replaces: on mobile the
  // sidebar is an overlay, so navigating without closing it leaves settings
  // opened underneath the sheet that opened it.
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarChromeHeader
      isElectron={isElectron}
      actions={
        // Centred, with symmetric padding, so the strip stays balanced at any
        // icon count — it has been as high as seven and is now six.
        //
        // It used to be left-aligned to the wordmark's edge, which meant
        // carrying the workspace titlebar-control inset (~46px). That inset
        // exists to clear the macOS traffic lights, and the traffic lights only
        // occupy the *first* row — this row sits below the titlebar region and
        // never needed it. At four icons the dead space read as margin; at six
        // it pushed the strip into the right edge, which is the imbalance
        // Michael saw.
        //
        // `flex-wrap` is the overflow behaviour rather than a scroller or a
        // squeeze. Six 28px buttons plus their gaps come to ~188px, which still
        // fits the 192px of usable width at the sidebar's 208px minimum — so
        // nothing wraps today, and a seventh icon would drop to a second
        // centred line rather than overflowing the panel.
        <div className="relative z-10 flex shrink-0 flex-wrap items-center justify-center gap-1 px-2 pb-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  type="button"
                  className={cn(
                    HEADER_ACTION_BUTTON_CLASS,
                    showChats && "bg-sidebar-row-hover text-sidebar-foreground",
                  )}
                  onClick={onToggleChats}
                  aria-label={showChats ? "Show project list" : "Show chat list"}
                  aria-pressed={showChats}
                  data-testid="sidebar-chats-toggle"
                />
              }
            >
              <MessageCircleIcon
                className={cn(HEADER_ACTION_ICON_CLASS, showChats && "text-sidebar-foreground")}
              />
              <TouchTarget />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{showChats ? "Show projects" : "Show chats"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  type="button"
                  className={cn(
                    HEADER_ACTION_BUTTON_CLASS,
                    showArchived && "bg-sidebar-row-hover text-sidebar-foreground",
                  )}
                  onClick={onToggleArchived}
                  aria-label={showArchived ? "Show active threads" : "Show archived threads"}
                  aria-pressed={showArchived}
                  data-testid="sidebar-archive-toggle"
                />
              }
            >
              <ArchiveIcon
                className={cn(HEADER_ACTION_ICON_CLASS, showArchived && "text-sidebar-foreground")}
              />
              <TouchTarget />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {showArchived ? "Show active threads" : "Show archived threads"}
            </TooltipPopup>
          </Tooltip>
          {/* Outside the `showProjectActions` gate: when a machine drops out,
              this is the icon that says so, and a client with no projects is
              exactly the client whose connections are worth checking. */}
          <SidebarConnectionsMenu />
          {showProjectActions ? (
            <>
              {/* The projects popover replaces the old "New project" button
                  rather than joining it. Creating a folder on this machine is
                  still here — it moved into the popover's foot, where it sits
                  next to the projects it would be filed under. */}
              <SidebarProjectsMenu onNewProject={onNewProject} />
              <SidebarV2ViewMenu />
            </>
          ) : null}
          {/* Last, and outside the gate. Settings is the one control here that
              is about the app rather than about what is in the sidebar, so it
              takes the end of the strip and keeps it whether or not a project
              exists — a client with none is one that may well need to reach
              its connections and providers. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  type="button"
                  className={HEADER_ACTION_BUTTON_CLASS}
                  onClick={handleSettingsClick}
                  aria-label="Settings"
                  data-testid="sidebar-settings"
                />
              }
            >
              <SettingsIcon className={HEADER_ACTION_ICON_CLASS} />
              <TouchTarget />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Settings</TooltipPopup>
          </Tooltip>
        </div>
      }
    />
  );
});
