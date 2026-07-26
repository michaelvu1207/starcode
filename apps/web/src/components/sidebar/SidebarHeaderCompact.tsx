/**
 * Fork-owned compact sidebar header.
 *
 * Upstream stacks three rows above the thread list: the brand row, a
 * full-width "Search ⌘K" bar with the compose button beside it, and the
 * "All projects" picker with the view menu and new-project button. Two of the
 * three rows spend a full row of sidebar height on controls that are one click
 * each, and the project picker is dead weight at our project count.
 *
 * This collapses all three into two: the wordmark on its own row, and one
 * compact icon strip beneath it. The actions are the same actions — the search
 * overlay is still the command dialog ⌘K opens, new thread is still
 * `handleNewThreadClick`, new project is still the add-project command
 * palette — so nothing here owns behaviour, only placement. Fork-owned so the
 * diff inside `SidebarV2.tsx` stays a call site.
 *
 * The collapse control leads the strip. It is the same `SidebarTrigger` the
 * fixed workspace control renders, and that control still appears — but only
 * while the sidebar is closed, because a button that lives inside the sidebar
 * cannot be the way back into it. See `AppSidebarLayout.SidebarControl`.
 *
 * The project *filter* the picker used to drive is guarded separately; see
 * `sidebarProjectScope.ts`.
 */
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { MapIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { CommandDialogTrigger } from "../ui/command";
import { SidebarMenuButton, SidebarTrigger } from "../ui/sidebar";
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
  // Same binding the fixed workspace control advertises, so both entry points
  // teach the same shortcut.
  const sidebarShortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  return (
    <SidebarChromeHeader
      isElectron={isElectron}
      actions={
        // Centred, with symmetric padding, so the strip stays balanced at any
        // icon count — it has already gone from four to six.
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
        // squeeze: the sidebar is resizable down to 208px, where seven 28px
        // buttons plus their gaps come to 220px — past the 192px of usable
        // width — so the last icon wraps to a second centred line rather than
        // overflowing the panel. That wrap only happens at the narrowest few
        // pixels of the resize range; at the default width all seven sit on
        // one line.
        <div className="relative z-10 flex shrink-0 flex-wrap items-center justify-center gap-1 px-2 pb-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarTrigger aria-label="Hide sidebar" className={HEADER_ACTION_BUTTON_CLASS} />
              }
            />
            <TooltipPopup side="bottom">
              {sidebarShortcutLabel ? `Hide sidebar (${sidebarShortcutLabel})` : "Hide sidebar"}
            </TooltipPopup>
          </Tooltip>
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
          {/* Outside the `showProjectActions` gate: the Workbench is how an
              operator sees every machine at once, and it must not disappear
              with the project buttons on a client that has no projects yet.
              A map, not a grid: what is behind this button is the star map, and
              a grid glyph promised a dashboard of tiles that has not been there
              since F14. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  type="button"
                  className={HEADER_ACTION_BUTTON_CLASS}
                  aria-label="Workbench"
                  data-testid="sidebar-workbench"
                  render={<Link to="/workbench" />}
                />
              }
            >
              <MapIcon className={HEADER_ACTION_ICON_CLASS} />
              <TouchTarget />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Workbench</TooltipPopup>
          </Tooltip>
          {/* Also outside the `showProjectActions` gate, and for a stronger
              reason than the Workbench: when a machine drops out, this is the
              icon that says so, and a client with no projects is exactly the
              client whose connections are worth checking. */}
          <SidebarConnectionsMenu />
          {showProjectActions ? (
            <>
              {/* The projects popover replaces the old "New project" button
                  rather than joining it: the strip is at seven icons and an
                  eighth wraps at the sidebar's minimum width. Creating a folder
                  on this machine is still here — it moved into the popover's
                  foot, where it sits next to the projects it would be filed
                  under. */}
              <SidebarProjectsMenu onNewProject={onNewProject} />
              <SidebarV2ViewMenu />
            </>
          ) : null}
        </div>
      }
    />
  );
});
