import { useAtomValue } from "@effect/atom-react";
import { SettingsIcon } from "lucide-react";
import { memo, useCallback, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { APP_STAGE_LABEL } from "../../branding";
import { cn } from "../../lib/utils";
import { primaryServerConfigAtom } from "../../state/server";
import { resolveSidebarStageBadgeLabel } from "../Sidebar.logic";
import { SidebarStageBackdrop, resolveSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { StarcodeWordmark } from "../brand/StarcodeWordmark";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  actions,
}: {
  isElectron: boolean;
  /**
   * The action row rendered beneath the brand. Upstream put its actions beside
   * the brand and had the brand give way as the sidebar narrowed; giving them
   * their own row means neither has to yield, so the wordmark is never
   * truncated and the icons never crowd it.
   */
  actions?: ReactNode;
}) {
  const stageLabel = useSidebarStageLabel();
  const backdropVariant = resolveSidebarStageBackdropVariant(stageLabel);

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative shrink-0 gap-0 px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      {/* The titlebar band. Deliberately empty: on macOS the window's traffic
          lights physically occupy its left 90px, and keeping it at the topbar's
          exact height also holds the sidebar's divider in line with the main
          pane's header.

          The wordmark used to live here, inset past those 90px. That inset
          resolves to 130px on macOS, so at the sidebar's 208px minimum the
          brand had 78px for a wordmark needing ~79px and collapsed to nothing —
          invisible on the desktop app only, which is why it survived a browser
          review. The brand now gets its own full-width row below the band,
          where no OS chrome can crowd it and it can be as large as it likes. */}
      <div className="h-[var(--workspace-topbar-height)] shrink-0" aria-hidden="true" />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {actions}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 flex min-w-0 shrink-0 items-center justify-center rounded-md px-3 pb-1 outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <StarcodeWordmark size="masthead" tone={onBackdrop ? "on-backdrop" : "default"} />
    </Link>
  );
}

function useSidebarStageLabel() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveSidebarStageBadgeLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-4.5 shrink-0" />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});
