/**
 * Accounts & Usage — every machine's provider accounts, their remaining
 * allowance, and what they have spent.
 *
 * Account identity (email, plan, auth status) streams live over the server
 * config subscription; the numbers are polled over HTTP every 30s. The panel
 * renders the identity half regardless, so a machine whose usage read fails
 * still shows which accounts it is running.
 *
 * Two provenances live here and are kept visually apart end to end: the
 * account cards count turns starcode ran, the historical section counts
 * messages found in the CLIs' own on-disk stores. They overlap, so nothing in
 * this file ever adds one to the other.
 *
 * @module AccountsUsagePanel
 */
import { CircleAlertIcon, HistoryIcon, LoaderIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import type {
  CliProviderUsage,
  CliUsageProvider,
  CliUsageTotals,
  UsageRateLimitSnapshot,
  UsageTotals,
} from "@t3tools/contracts";

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
  type AccountsUsageView,
  type CliHistoryMachineView,
  cliProviderWindows,
  type CliUsageWindows,
  foldCliModelRows,
  formatCount,
  formatDayRange,
  formatResetCountdown,
  formatTokens,
  formatUsd,
  peakUsedPercent,
  unpricedShare,
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

/**
 * The CLI a historical figure was read out of, and where on disk that store
 * lives. Naming the directory is the point: it is what makes "this is not the
 * same number as the one above" concrete rather than a claim.
 */
const CLI_PROVIDER_META: Record<
  CliUsageProvider,
  { readonly label: string; readonly driver: string; readonly home: string }
> = {
  claude: { label: "Claude Code", driver: "claudeAgent", home: "~/.claude" },
  codex: { label: "Codex", driver: "codex", home: "~/.codex" },
};

/** One cumulative window. `pending` renders "computing", never a false zero. */
function CliWindowStat({
  label,
  totals,
  pending,
  emphasis,
}: {
  label: string;
  totals: CliUsageTotals;
  pending: boolean;
  emphasis: boolean;
}) {
  return (
    <div
      className={cn("rounded-lg px-2.5 py-2", emphasis ? "border border-border/60" : "bg-muted/25")}
    >
      <p className="text-[11px] text-muted-foreground/70">{label}</p>
      <p
        className={cn(
          "pt-0.5 font-semibold tabular-nums text-foreground",
          emphasis ? "text-xl" : "text-sm",
        )}
      >
        {pending ? (
          <span className="text-base font-normal text-muted-foreground/60">computing…</span>
        ) : (
          formatUsd(totals.costUsd)
        )}
      </p>
      <p className="text-[11px] tabular-nums text-muted-foreground/60">
        {pending ? "—" : `${formatCount(totals.messages)} msg`}
      </p>
    </div>
  );
}

function CliWindowStats({
  windows,
  pending,
  emphasis = false,
}: {
  windows: CliUsageWindows;
  pending: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <CliWindowStat
        label="All time"
        totals={windows.allTime}
        pending={pending}
        emphasis={emphasis}
      />
      <CliWindowStat
        label="Last 30 days"
        totals={windows.last30Days}
        pending={pending}
        emphasis={emphasis}
      />
      <CliWindowStat
        label="Last 7 days"
        totals={windows.last7Days}
        pending={pending}
        emphasis={emphasis}
      />
      <CliWindowStat label="Today" totals={windows.today} pending={pending} emphasis={emphasis} />
    </div>
  );
}

/**
 * The one thing that must never be swallowed: a model with no vendored rate
 * still contributes tokens, so the dollar figure beside it is a floor.
 */
function UnpricedNote({ totals }: { totals: CliUsageTotals }) {
  const share = unpricedShare(totals);
  if (totals.unpricedMessages === 0 || share === null) return null;
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-warning-foreground">
      <CircleAlertIcon className="size-3.5 shrink-0 translate-y-px" />
      <span>
        A floor, not a total — {formatCount(totals.unpricedMessages)} of{" "}
        {formatCount(totals.messages)} messages ({Math.round(share * 100)}%) ran on models with no
        known price. Their tokens are counted here; their cost is not.
      </span>
    </p>
  );
}

function CliModelRows({ models }: { models: CliProviderUsage["models"] }) {
  const { rows, shareBasis } = foldCliModelRows(models);
  if (rows.length === 0) return null;

  return (
    <div className="grid gap-1.5">
      {rows.map((row) => {
        const percent = Math.round(row.share * 100);
        const tokens =
          row.totals.inputTokens +
          row.totals.outputTokens +
          row.totals.cacheWriteTokens +
          row.totals.cacheReadTokens;
        return (
          <div key={row.model} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="w-36 shrink-0 truncate text-muted-foreground" title={row.model}>
              {row.model}
            </span>
            {row.priced ? (
              <div
                className="h-1.5 min-w-[3rem] flex-1 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label={`${row.model} share of ${shareBasis === "cost" ? "cost" : "messages"}`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(percent, 1)}%` }}
                />
              </div>
            ) : (
              // The same striped track the rate-limit bars use for "not
              // reported": an unpriced model has no cost to plot, and a bar at
              // zero would read as "this one was free".
              <div className="h-1.5 min-w-[3rem] flex-1 rounded-full bg-[repeating-linear-gradient(45deg,var(--color-muted)_0px,var(--color-muted)_3px,transparent_3px,transparent_6px)]" />
            )}
            <span className="shrink-0 tabular-nums text-muted-foreground/60">
              {formatTokens(tokens)} tok
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums text-foreground">
              {row.priced ? (
                formatUsd(row.totals.costUsd)
              ) : (
                <span className="text-muted-foreground/60">no price</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CliProviderCard({ usage }: { usage: CliProviderUsage }) {
  const meta = CLI_PROVIDER_META[usage.provider];
  const range = formatDayRange(usage.firstDay, usage.lastDay);

  return (
    <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <DriverIcon driver={meta.driver} className="size-4 shrink-0 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">{meta.label}</h4>
          <span className="text-xs text-muted-foreground/60">{meta.home}</span>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground/70">
          {formatCount(usage.sessionFiles)} session files
          {range === null ? "" : ` · ${range}`}
        </span>
      </div>

      <div className="pt-2.5">
        <CliWindowStats windows={cliProviderWindows(usage)} pending={false} />
      </div>

      {usage.allTime.unpricedMessages > 0 ? (
        <div className="pt-2">
          <UnpricedNote totals={usage.allTime} />
        </div>
      ) : null}

      <div className="pt-2.5">
        <CliModelRows models={usage.models} />
      </div>
    </div>
  );
}

function CliHistoryMachine({
  label,
  history,
  showLabel,
}: {
  label: string;
  history: CliHistoryMachineView;
  showLabel: boolean;
}) {
  return (
    <div className="space-y-2 px-3 sm:px-4">
      {showLabel ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MonitorIcon className="size-3.5" />
            {label}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground/60">
            {history.pending ? "scanning…" : `${formatCount(history.filesScanned)} files scanned`}
          </span>
        </div>
      ) : null}

      {history.failed ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive-foreground">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          Could not read this machine's CLI session stores.
        </p>
      ) : history.pending ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
          <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
          Reading the CLI session stores — the first pass over a large store takes about a minute.
        </p>
      ) : !history.hasUsage ? (
        <p className="text-xs text-muted-foreground/70">
          No Claude Code or Codex history on this machine.
        </p>
      ) : (
        history.providers.map((provider) => (
          <CliProviderCard key={provider.provider} usage={provider} />
        ))
      )}
    </div>
  );
}

/**
 * Historical CLI spend — a different provenance from everything above it.
 *
 * The panel above counts turns starcode itself ran; this counts messages found
 * in the CLIs' own on-disk stores. They overlap for any turn starcode ran
 * through a CLI, so the two are never summed and are never shown side by side
 * without saying which is which.
 */
function CliHistorySection({ view }: { view: AccountsUsageView }) {
  const history = view.cliHistory;
  // Nothing to say when no connected machine's server knows about CLI history
  // — an empty section would read as "you have spent nothing".
  if (!history.reported) return null;

  const machines = view.groups.filter((group) => group.cliHistory.reported);

  return (
    <SettingsSection
      title="Historical CLI usage"
      icon={<HistoryIcon className="size-4 text-muted-foreground" />}
      headerAction={
        history.scanning ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
            <LoaderIcon className="size-3.5 animate-spin" />
            computing
          </span>
        ) : (
          <span className="text-xs tabular-nums text-muted-foreground/60">
            {formatCount(history.filesScanned)} session files
          </span>
        )
      }
    >
      <div className="px-3 sm:px-4">
        <CliWindowStats windows={history.windows} pending={history.pending} emphasis />
      </div>

      <p className="px-3 pt-1 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Read from the CLIs' own session stores on each machine —{" "}
        <span className="font-mono">~/.claude</span> and <span className="font-mono">~/.codex</span>{" "}
        — and priced from a vendored rate table. This is spend from before, or outside, starcode,
        which is why the totals above can read zero while these do not. The two overlap for any turn
        starcode ran through a CLI, so they are reported separately and never added together.
      </p>

      {history.costIsFloor ? (
        <div className="px-3 sm:px-4">
          <UnpricedNote totals={history.windows.allTime} />
        </div>
      ) : null}

      {history.failed && machines.length > 1 ? (
        <p className="flex items-center gap-1.5 px-3 text-xs text-destructive-foreground sm:px-4">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          At least one machine could not read its CLI session stores, so these totals are
          incomplete.
        </p>
      ) : null}

      {machines.map((group) => (
        <CliHistoryMachine
          key={group.environmentId}
          label={group.label}
          history={group.cliHistory}
          showLabel={machines.length > 1 || group.cliHistory.pending || group.cliHistory.failed}
        />
      ))}
    </SettingsSection>
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
            <p className="text-xs text-muted-foreground/60">turns run through starcode</p>
          </div>
          <div className="rounded-xl border border-border/60 px-3 py-3">
            <p className="text-xs text-muted-foreground/70">Spend, last 7 days</p>
            <p className="pt-0.5 text-xl font-semibold tabular-nums text-foreground">
              {formatUsd(view.week.costUsd)}
            </p>
            <p className="text-xs text-muted-foreground/60">turns run through starcode</p>
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
          {view.cliHistory.reported
            ? " These figures cover turns starcode itself ran; everything the CLIs spent outside it is under Historical CLI usage below."
            : ""}
          {view.mixedDays
            ? " These machines are in different time zones, so “today” differs between them."
            : ""}
        </p>
      </SettingsSection>

      <CliHistorySection view={view} />

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
