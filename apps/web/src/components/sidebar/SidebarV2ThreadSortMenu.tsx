/**
 * Sort control for the sidebar v2 inbox. Fork-owned so the toolbar diff inside
 * SidebarV2.tsx stays a single element, styled to match the sibling toolbar
 * buttons and the sort menu sidebar v1 already ships.
 */
import type { SidebarV2ThreadSortOrder } from "@t3tools/contracts";
import { ArrowUpDownIcon } from "lucide-react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const THREAD_SORT_ORDER_LABELS: Record<SidebarV2ThreadSortOrder, string> = {
  activity: "Needs attention",
  created_at: "Newest first",
};

export function SidebarV2ThreadSortMenu() {
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
                  aria-label="Sort threads"
                />
              }
            />
          }
        >
          <ArrowUpDownIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort threads</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
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
