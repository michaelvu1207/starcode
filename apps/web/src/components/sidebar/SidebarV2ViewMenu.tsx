/**
 * View control for the sidebar v2 list: what the list is a list of (the flat
 * inbox or one group per connected machine) and, within it, what order the
 * threads take. Fork-owned so the toolbar diff inside SidebarV2.tsx stays a
 * single element, styled to match the sibling toolbar buttons and the sort
 * menu sidebar v1 already ships.
 *
 * Both radio groups live in one menu because they answer the same question —
 * "how do I want to read this list" — and grouping by machine does not change
 * what order threads take inside a machine.
 */
import type { SidebarV2ThreadSortOrder, SidebarV2ViewMode } from "@t3tools/contracts";
import { SlidersHorizontalIcon } from "lucide-react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const VIEW_MODE_LABELS: Record<SidebarV2ViewMode, string> = {
  inbox: "Inbox",
  connections: "Connections",
};

const THREAD_SORT_ORDER_LABELS: Record<SidebarV2ThreadSortOrder, string> = {
  activity: "Needs attention",
  created_at: "Newest first",
};

export function SidebarV2ViewMenu() {
  const viewMode = useClientSettings((settings) => settings.sidebarV2ViewMode);
  const threadSortOrder = useClientSettings((settings) => settings.sidebarV2ThreadSortOrder);
  const updateSettings = useUpdateClientSettings();

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  className="size-8 shrink-0 justify-center rounded-md bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                  type="button"
                  aria-label="Thread list view"
                  data-testid="sidebar-v2-view-menu"
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
        </TooltipTrigger>
        <TooltipPopup side="right">Thread list view</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuGroup>
          <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">View</div>
          <MenuRadioGroup
            value={viewMode}
            onValueChange={(value) =>
              updateSettings({ sidebarV2ViewMode: value as SidebarV2ViewMode })
            }
          >
            {(Object.entries(VIEW_MODE_LABELS) as Array<[SidebarV2ViewMode, string]>).map(
              ([value, label]) => (
                <MenuRadioItem
                  key={value}
                  value={value}
                  closeOnClick
                  className="min-h-7 py-1 sm:text-xs"
                  data-testid={`sidebar-v2-view-mode-${value}`}
                >
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">Sort threads</div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) =>
              updateSettings({ sidebarV2ThreadSortOrder: value as SidebarV2ThreadSortOrder })
            }
          >
            {(
              Object.entries(THREAD_SORT_ORDER_LABELS) as Array<[SidebarV2ThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem
                key={value}
                value={value}
                closeOnClick
                className="min-h-7 py-1 sm:text-xs"
                data-testid={`sidebar-v2-thread-sort-${value}`}
              >
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
