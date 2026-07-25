/**
 * Accounts & Usage — every machine's provider accounts, their remaining
 * allowance, and what they have spent.
 *
 * Account identity (email, plan, auth status) streams live over the server
 * config subscription; the numbers are polled over HTTP every 30s. The panel
 * renders the identity half regardless, so a machine whose usage read fails
 * still shows which accounts it is running.
 *
 * @module AccountsUsagePanel
 */
import { CircleAlertIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { UsageRateLimitSnapshot, UsageTotals } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useAccountsUsage } from "../../state/usage";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import {
  SettingsPageContainer,
  SettingsSection,
  useRelativeTimeTick,
} from "../settings/settingsLayout";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type AccountUsageRow,
  type AccountsUsageEnvironmentGroup,
  formatResetCountdown,
  formatTokens,
  formatUsd,
  peakUsedPercent,
} from "./AccountsUsage.logic";

function driverLabel(driver: string): string {
  return (
    PROVIDER_CLIENT_DEFINITIONS.find((definition) => definition.value === driver)?.label ?? driver
  );
}

function DriverIcon({ driver, className }: { driver: string; className?: string }) {
  const Icon = PROVIDER_CLIENT_DEFINITIONS.find((definition) => definition.value === driver)?.icon;
  return Icon ? <Icon className={className} /> : null;
}

/** Bar colour tracks how close the window is to cutting the account off. */
function usageBarTone(usedPercent: number): string {
  if (usedPercent >= 90) return "bg-destructive";
  if (usedPercent >= 70) return "bg-warning";
  return "bg-primary";
}

function RateLimitBars({
  rateLimits,
  nowMs,
}: {
  rateLimits: UsageRateLimitSnapshot;
  nowMs: number;
}) {
  return (
    <div className="grid gap-2">
      {rateLimits.windows.map((window) => {
        const countdown = formatResetCountdown(window.resetsAt, nowMs);
        const usedPercent = window.usedPercent;
        return (
          <div key={window.key} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">{window.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {usedPercent === null ? (
                  <span className="text-muted-foreground/60">not reported</span>
                ) : (
                  `${Math.round(usedPercent)}%`
                )}
                {countdown ? (
                  <span className="text-muted-foreground/60"> · resets in {countdown}</span>
                ) : null}
              </span>
            </div>
            {usedPercent === null ? (
              // A striped track, not an empty bar: the provider only sends a
              // consumption figure once the account nears its limit, and a 0%
              // bar would read as "plenty left".
              <div className="h-1.5 w-full rounded-full bg-[repeating-linear-gradient(45deg,var(--color-muted)_0px,var(--color-muted)_3px,transparent_3px,transparent_6px)]" />
            ) : (
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label={`${window.label} usage`}
                aria-valuenow={Math.round(usedPercent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    usageBarTone(usedPercent),
                  )}
                  style={{ width: `${Math.max(usedPercent, 1)}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TotalsLine({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="text-muted-foreground/70">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{formatUsd(totals.costUsd)}</span>
      <span className="text-muted-foreground/60">
        · {totals.turns} {totals.turns === 1 ? "turn" : "turns"} ·{" "}
        {formatTokens(totals.inputTokens + totals.outputTokens)} tok
      </span>
    </div>
  );
}

function AccountCard({ account, nowMs }: { account: AccountUsageRow; nowMs: number }) {
  const peak = peakUsedPercent(account.rateLimits);

  return (
    <div className="rounded-xl px-3 py-3 transition-colors hover:bg-muted/20 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DriverIcon driver={account.driver} className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
              {account.displayName}
            </h3>
            {account.planLabel ? (
              <Badge variant="secondary" size="sm">
                {account.planLabel}
              </Badge>
            ) : null}
            {account.rateLimits?.status === "rejected" ? (
              <Badge variant="error" size="sm">
                Limit reached
              </Badge>
            ) : account.rateLimits?.status === "warning" ? (
              <Badge variant="warning" size="sm">
                Near limit
              </Badge>
            ) : null}
            {account.orphanedUsage ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Badge variant="outline" size="sm">
                      Removed
                    </Badge>
                  }
                />
                <TooltipPopup side="top">
                  Usage recorded for a provider instance that is no longer configured.
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>

          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
            <span>{driverLabel(account.driver)}</span>
            {account.email ? (
              <>
                <span aria-hidden>·</span>
                <RedactedSensitiveText
                  value={account.email}
                  ariaLabel="Toggle account email visibility"
                  revealTooltip="Click to reveal email"
                  hideTooltip="Click to hide email"
                />
              </>
            ) : account.authStatus === "unauthenticated" ? (
              <>
                <span aria-hidden>·</span>
                <span>Not signed in</span>
              </>
            ) : null}
          </p>

          <div className="space-y-0.5 pt-1">
            <TotalsLine label="Today" totals={account.today} />
            <TotalsLine label="7 days" totals={account.week} />
          </div>
        </div>

        <div className="w-full shrink-0 sm:w-56">
          {account.rateLimits === null ? (
            <p className="text-xs text-muted-foreground/60">
              No rate-limit data yet — reported by the provider during a turn.
            </p>
          ) : (
            <RateLimitBars rateLimits={account.rateLimits} nowMs={nowMs} />
          )}
          {peak !== null && peak >= 90 ? (
            <p className="pt-2 text-xs text-destructive-foreground">
              {Math.round(peak)}% of the window used.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EnvironmentGroup({
  group,
  nowMs,
}: {
  group: AccountsUsageEnvironmentGroup;
  nowMs: number;
}) {
  const headerAction: ReactNode = (
    <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
      {group.timeZone ? <span>{group.timeZone}</span> : null}
      <span className="tabular-nums">{formatUsd(group.today.costUsd)} today</span>
    </div>
  );

  return (
    <SettingsSection
      title={group.label}
      icon={<MonitorIcon className="size-4 text-muted-foreground" />}
      headerAction={headerAction}
    >
      {group.accounts.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">
          {group.configAvailable
            ? "No provider instances are configured on this machine."
            : "Not connected — nothing to report yet."}
        </p>
      ) : (
        group.accounts.map((account) => (
          <AccountCard key={account.instanceId} account={account} nowMs={nowMs} />
        ))
      )}
      {group.accounts.length > 0 && !group.usageAvailable ? (
        <p className="flex items-center gap-1.5 px-3 pt-1 text-xs text-muted-foreground/70 sm:px-4">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          Usage could not be read from this machine. Its server may predate the usage API.
        </p>
      ) : null}
    </SettingsSection>
  );
}

export function AccountsUsagePanel() {
  const view = useAccountsUsage();
  // Reset countdowns are minute-resolution; a per-minute tick is enough and
  // keeps this panel off the per-second render path.
  const nowMs = useRelativeTimeTick(60_000);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Accounts & Usage"
        headerAction={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <RefreshCwIcon className="size-3.5" />
            every 30s
          </span>
        }
      >
        <div className="grid gap-3 px-3 sm:grid-cols-3 sm:px-4">
          <div className="rounded-xl border border-border/60 px-3 py-3">
            <p className="text-xs text-muted-foreground/70">Spend today</p>
            <p className="pt-0.5 text-xl font-semibold tabular-nums text-foreground">
              {formatUsd(view.today.costUsd)}
            </p>
          </div>
          <div className="rounded-xl border border-border/60 px-3 py-3">
            <p className="text-xs text-muted-foreground/70">Spend, last 7 days</p>
            <p className="pt-0.5 text-xl font-semibold tabular-nums text-foreground">
              {formatUsd(view.week.costUsd)}
            </p>
          </div>
          <div className="rounded-xl border border-border/60 px-3 py-3">
            <p className="text-xs text-muted-foreground/70">Accounts</p>
            <p className="pt-0.5 text-xl font-semibold tabular-nums text-foreground">
              {view.accountCount}
            </p>
            <p className="text-xs text-muted-foreground/60">
              across {view.groups.length} {view.groups.length === 1 ? "machine" : "machines"}
            </p>
          </div>
        </div>
        <p className="px-3 pt-1 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
          One account is one provider instance, pinned to its own config directory. Spend is what
          the provider reported per turn — subscription providers report none, so those accounts
          show tokens without a dollar figure.
          {view.mixedDays
            ? " These machines are in different time zones, so “today” differs between them."
            : ""}
        </p>
      </SettingsSection>

      {view.groups.length === 0 ? (
        <p className="px-3 text-[13px] text-muted-foreground/80 sm:px-4">
          No machines are connected yet.
        </p>
      ) : (
        view.groups.map((group) => (
          <EnvironmentGroup key={group.environmentId} group={group} nowMs={nowMs} />
        ))
      )}
    </SettingsPageContainer>
  );
}
