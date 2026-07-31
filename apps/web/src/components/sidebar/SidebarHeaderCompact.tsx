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
 * compact icon strip beneath it. The actions are the same actions — new project
 * is still the add-project command dialog — so nothing here owns behaviour, only
 * placement. Fork-owned so the diff inside `SidebarV2.tsx` stays a call site.
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
 * One icon arrived: **Settings**, which was a full-width labelled row at the
 * foot of the sidebar. It is an app-level control like the rest of this strip,
 * and it was the last thing keeping `SidebarChromeFooter` from collapsing on
 * the common case where neither update pill has anything to say.
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
import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarMenuButton, SidebarTrigger, useSidebar } from "../ui/sidebar";
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
}: {
  onNewProject: () => void;
  /** False until at least one project exists — matches the old row-3 gate. */
  showProjectActions: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Same binding the fixed workspace control advertises, so both entry points
  // teach the same shortcut.
  const sidebarShortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");
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
        // icon count — it has been as high as seven and is now five.
        //
        // It used to be left-aligned to the wordmark's edge, which meant
        // carrying the workspace titlebar-control inset (~46px). That inset
        // exists to clear the macOS traffic lights, and the traffic lights only
        // occupy the *first* row — this row sits below the titlebar region and
        // never needed it. At three icons the dead space reads as margin; at
        // five it still stays balanced within the sidebar, which is the
        // geometry Michael wanted.
        //
        // `flex-wrap` is the overflow behaviour rather than a scroller or a
        // squeeze. Five 28px buttons plus their gaps come to ~156px, which
        // still fits the 192px of usable width at the sidebar's 208px minimum —
        // so nothing wraps today, and a sixth icon would drop to a second
        // centred line rather than overflowing the panel.
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
