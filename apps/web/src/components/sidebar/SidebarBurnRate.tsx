/**
 * The burn-rate strip under the masthead: what every account on every connected
 * machine is spending per hour, in one line.
 *
 * It reads the same `useAccountsUsage` fold the Accounts & Usage panel does, so
 * the two can never disagree, and it links there because a rate is a prompt to
 * ask *which account* — a question only the panel can answer.
 *
 * Mounting this in the sidebar makes the usage poll (one GET per machine every
 * 30s) run for the whole session rather than only while the panel is open. That
 * is the price of a live figure, and it is the same request either way.
 *
 * @module SidebarBurnRate
 */
import { Link } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { cn } from "../../lib/utils";
import { useAccountsUsage } from "../../state/usage";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildBurnRateView } from "./SidebarBurnRate.logic";

export const SidebarBurnRate = memo(function SidebarBurnRate({
  onBackdrop,
}: {
  /** The stage backdrop reaches this row, so the text has to lift off it. */
  onBackdrop: boolean;
}) {
  const usage = useAccountsUsage();
  const { isMobile, setOpenMobile } = useSidebar();

  // On mobile the sidebar is an overlay: navigating without closing it would
  // open settings underneath the sheet that opened it.
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const view = buildBurnRateView({
    reported: usage.lastHourReported,
    totals: usage.lastHour,
    machines: usage.lastHourMachines,
    connectedMachines: usage.groups.length,
    activeAccounts: usage.lastHourActiveAccounts,
  });

  if (!view.visible) return null;

  return (
    <div className="relative z-10 flex shrink-0 items-center justify-center px-3 pb-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label={view.ariaLabel}
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] leading-none outline-hidden ring-ring transition-colors focus-visible:ring-2",
                onBackdrop ? "text-white/75 hover:bg-white/10" : "hover:bg-muted/50",
              )}
              data-testid="sidebar-burn-rate"
              onClick={handleClick}
              to="/settings/usage"
            >
              <GaugeIcon
                className={cn(
                  "size-3 shrink-0",
                  onBackdrop ? "text-white/60" : "text-muted-foreground/60",
                )}
              />
              <span
                className={cn(
                  "truncate tabular-nums",
                  view.state === "idle"
                    ? onBackdrop
                      ? "text-white/60"
                      : "text-muted-foreground/60"
                    : cn("font-medium", onBackdrop ? "text-white/90" : "text-foreground"),
                )}
              >
                {view.primary}
              </span>
              {view.secondary === null ? null : (
                <span
                  className={cn(
                    "truncate tabular-nums",
                    onBackdrop ? "text-white/50" : "text-muted-foreground/60",
                  )}
                >
                  {view.secondary}
                </span>
              )}
            </Link>
          }
        />
        <TooltipPopup side="bottom">{view.tooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
});
