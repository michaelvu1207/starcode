/**
 * The connections dropdown: every paired machine's health, latency, and spend
 * in one glance, hung off the sidebar's icon strip.
 *
 * Fork-owned and self-contained — it reads its own state and threads no props,
 * so adding it to the header is one element in `SidebarHeaderCompact` and no
 * change at all in `SidebarV2.tsx`.
 *
 * A popover rather than the `Menu` the view control uses: these are rows with
 * a meter and a button in them, not menu items, and a menu's roving-focus
 * semantics would make the retry action awkward to reach.
 *
 * Everything it shows already exists somewhere — the supervisor's connection
 * state, and the usage snapshot behind Settings → Usage (an `Atom.family` with
 * a 5-minute idle TTL, so opening this shares that cache rather than starting a
 * second poll) — except the ping, which is the fork's own timing of the probe
 * the supervisor already fires.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@starcode/contracts";
import { Link } from "@tanstack/react-router";
import { PlugZapIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { environmentCatalog } from "../../connection/catalog";
import { useConnectionPings } from "../../state/connectionPing";
import { useEnvironmentConnectionStates } from "../../state/connectionStates";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentUsageSnapshotsAtom } from "../../state/usage";
import { formatUsd } from "../usage/AccountsUsage.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ConnectionMark } from "./ConnectionMark";
import { openImportPicker } from "./importPicker";
import {
  buildConnectionMenuSummary,
  type ConnectionHealth,
  type ConnectionMenuRow,
} from "./SidebarConnectionsMenu.logic";

/**
 * Same geometry as the strip's other self-contained buttons. Kept verbatim
 * rather than shared, so the strip's styling stays greppable from any one of
 * its buttons.
 */
const TRIGGER_BUTTON_CLASS =
  "size-7 shrink-0 justify-center rounded-md bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";

/** A second-resolution clock, running only while the dropdown is open. */
function useSecondTicker(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return nowMs;
}

/**
 * The hang-indent the status line and the meter share, so both align under the
 * machine's name rather than under its dot. It is the width of everything that
 * precedes the name on the row above: the 8px health dot, the 14px machine
 * mark, and the two 8px gaps between them.
 */
const ROW_BODY_INDENT_CLASS = "pl-[38px]";

const HEALTH_DOT_CLASS: Record<ConnectionHealth, string> = {
  connected: "bg-success",
  waiting: "bg-warning",
  down: "bg-destructive",
};

function RateLimitTrack({ percent }: { percent: number | null }): ReactNode {
  if (percent === null) {
    // Striped, not empty. The providers only send a consumption figure once an
    // account nears its limit, so an empty bar would claim headroom we have no
    // evidence for. Faint, because on a healthy fleet most rows are unknown and
    // a full-width hatch on every one of them would be the loudest thing in the
    // panel — it has to read as "nothing to report", not as a warning.
    return (
      <div
        aria-hidden
        className="h-1 w-full rounded-full opacity-40 bg-[repeating-linear-gradient(45deg,var(--color-muted)_0px,var(--color-muted)_2px,transparent_2px,transparent_5px)]"
      />
    );
  }
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-muted"
      role="meter"
      aria-label="Peak rate limit used"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          percent >= 90 ? "bg-destructive" : percent >= 80 ? "bg-warning" : "bg-success",
        )}
        style={{ width: `${Math.max(percent, 2)}%` }}
      />
    </div>
  );
}

function ConnectionRow({
  row,
  onRetry,
}: {
  row: ConnectionMenuRow;
  onRetry: (environmentId: EnvironmentId) => void;
}): ReactNode {
  return (
    <li
      className="list-none rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-row-hover"
      data-testid="connections-menu-row"
      data-environment-id={row.environmentId}
      data-health={row.health}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", HEALTH_DOT_CLASS[row.health])}
        />
        {/* Same mark the sidebar's connection groups wear, so the machine you
            are reading about here is the one you recognise there. */}
        <ConnectionMark environmentId={row.environmentId} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground">
          {row.label}
        </span>
        {row.isOwnBackend ? (
          <span
            data-testid="connection-own-backend"
            title="This app's own backend — threads here are visible only in this app"
            className="shrink-0 rounded-sm bg-muted/60 px-1 text-[10px] text-muted-foreground/70"
          >
            this app
          </span>
        ) : row.isLocal ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/60">Local</span>
        ) : null}
        <span
          className={cn(
            "shrink-0 font-mono text-[11px] tabular-nums",
            row.hasPing ? "text-muted-foreground" : "text-muted-foreground/50",
          )}
          data-testid="connections-menu-ping"
        >
          {row.pingLabel}
        </span>
      </div>
      <div className={cn("mt-0.5 flex items-baseline gap-1.5 text-[11px]", ROW_BODY_INDENT_CLASS)}>
        <span
          className={cn(
            "min-w-0 truncate",
            row.health === "down" ? "text-destructive/90" : "text-muted-foreground/70",
          )}
        >
          {row.statusLabel}
        </span>
        {row.spendTodayUsd === null ? null : (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            · {formatUsd(row.spendTodayUsd)}
          </span>
        )}
        {row.cliSpendTodayUsd !== null && row.cliSpendTodayUsd > 0 ? (
          <span
            className="shrink-0 tabular-nums text-muted-foreground/70"
            title="Today's spend in this machine's Claude Code and Codex session stores — separate from what starcode itself recorded, and overlapping it"
          >
            · {formatUsd(row.cliSpendTodayUsd)} CLI
          </span>
        ) : null}
        <span className="flex-1" />
        {row.retryAvailable ? (
          <button
            type="button"
            onClick={() => onRetry(row.environmentId as EnvironmentId)}
            className="shrink-0 cursor-pointer rounded text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            data-testid="connections-menu-retry"
          >
            Retry now
          </button>
        ) : null}
      </div>
      <div className={cn("mt-1 flex items-center gap-2", ROW_BODY_INDENT_CLASS)}>
        <RateLimitTrack percent={row.peakRateLimitPercent} />
        <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60">
          {row.peakRateLimitPercent === null ? "—" : `${Math.round(row.peakRateLimitPercent)}%`}
        </span>
      </div>
    </li>
  );
}

export function SidebarConnectionsMenu(): ReactNode {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectionStates = useEnvironmentConnectionStates();
  const usageSnapshots = useAtomValue(environmentUsageSnapshotsAtom);
  // Health and spend are watched whether or not the dropdown is open — the
  // badge has to be right *before* it is opened, which is the whole reason the
  // icon lives in the strip, and both of those atoms are already subscribed
  // elsewhere in the app. Only the ping is gated: it is the one read that
  // generates traffic nothing else would.
  const pings = useConnectionPings(open);
  const nowMs = useSecondTicker(open);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  const summary = useMemo(
    () =>
      buildConnectionMenuSummary(
        [...environments]
          .map((environment) => {
            const ping = pings.get(environment.environmentId);
            return {
              environmentId: environment.environmentId,
              label: environment.label,
              // "Local" means this machine, matching what the sidebar's
              // connection groups badge.
              isLocal: environment.environmentId === primaryEnvironmentId,
              isOwnBackend: environment.isOwnBackend,
              displayUrl: environment.displayUrl,
              state: connectionStates.get(environment.environmentId) ?? null,
              usage: usageSnapshots.get(environment.environmentId) ?? null,
              pingMs: ping?.rttMs ?? null,
              pingPending: ping?.isPending ?? false,
            };
          })
          // Same order as the sidebar's connection groups: this machine first,
          // then alphabetical. Two surfaces listing the same machines in
          // different orders makes both feel untrustworthy.
          .sort((left, right) => {
            if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
            return left.label.localeCompare(right.label);
          }),
        nowMs,
      ),
    [connectionStates, environments, nowMs, pings, primaryEnvironmentId, usageSnapshots],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  className={TRIGGER_BUTTON_CLASS}
                  type="button"
                  aria-label="Connections"
                  data-testid="sidebar-connections-menu"
                  data-needs-attention={summary.needsAttention ? "true" : undefined}
                />
              }
            />
          }
        >
          <span className="relative flex items-center justify-center">
            <PlugZapIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            {summary.needsAttention ? (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 size-1.5 rounded-full bg-destructive ring-2 ring-sidebar"
                data-testid="sidebar-connections-badge"
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {summary.downCount > 0
            ? `Connections (${summary.downCount} down)`
            : summary.needsAttention
              ? "Connections (nearing a limit)"
              : "Connections"}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="center"
        side="bottom"
        className="w-80"
        viewportClassName="px-1.5 py-1.5 [--viewport-inline-padding:--spacing(1.5)]"
      >
        <div className="flex flex-col">
          <div className="flex items-baseline justify-between px-2 pb-1.5 pt-0.5">
            <span className="text-xs font-medium text-foreground">Connections</span>
            <span className="flex items-baseline gap-2">
              {summary.hasFleetSpend ? (
                <span
                  className="text-[11px] tabular-nums text-muted-foreground"
                  data-testid="connections-menu-fleet-spend"
                >
                  {formatUsd(summary.fleetSpendTodayUsd)} today
                </span>
              ) : null}
              {summary.fleetCliSpendTodayUsd > 0 ? (
                <span
                  className="text-[11px] tabular-nums text-muted-foreground/70"
                  title="Today's spend in the machines' Claude Code and Codex session stores"
                  data-testid="connections-menu-fleet-cli-spend"
                >
                  {formatUsd(summary.fleetCliSpendTodayUsd)} CLI
                </span>
              ) : null}
            </span>
          </div>
          {summary.rows.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-muted-foreground/70">
              No machines paired yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {summary.rows.map((row) => (
                <ConnectionRow key={row.environmentId} row={row} onRetry={retryEnvironment} />
              ))}
            </ul>
          )}
          <div className="mt-1 flex items-center gap-2 border-t border-sidebar-border/60 px-2 pt-1.5 text-[11px]">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openImportPicker(null);
              }}
              className="cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              data-testid="connections-menu-import"
            >
              Import a conversation…
            </button>
            <span className="flex-1" />
            <Link
              to="/settings/usage"
              onClick={() => setOpen(false)}
              className="text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            >
              Manage
            </Link>
            <Link
              to="/settings/usage"
              onClick={() => setOpen(false)}
              className="text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            >
              Usage
            </Link>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
