/**
 * Usage — what Claude Code and Codex have cost over the last 30 days, and how
 * much headroom each account has left, on one screen.
 *
 * ## Why only one provenance
 *
 * This fork records its own per-turn spend, and the CLIs record theirs in
 * `~/.claude` and `~/.codex`. The second is a *superset* of the first for these
 * two drivers: every turn the fork runs through a CLI is written to that CLI's
 * own store. So the panel reports the CLI stores alone. That is not a loss of
 * information, and it removes the double-counting hazard an earlier version of
 * this page spent four paragraphs narrating.
 *
 * The cost of that choice, stated in the footer rather than hidden: drivers
 * that write no CLI store — cursor, grok, opencode — contribute no spend here.
 * They still appear in the limits strip, which reads the turn ledger.
 *
 * ## Why it must not scroll
 *
 * The page answers one question, so it fits in one view. Nothing here is
 * clipped to achieve that — the container still scrolls on a short window. The
 * budget is kept by showing one window (30 days) rather than four, aggregating
 * accounts and machines rather than enumerating them, and folding every model
 * past the third into one row.
 *
 * `UsageDailyChart` is the one element given real height, because it is the
 * only one that answers *when* — and one stacked chart says what a sparkline
 * per provider card would have said, in less room.
 *
 * @module AccountsUsagePanel
 */
import { CircleAlertIcon, InfoIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { CliUsageProvider, CliUsageTotals, EnvironmentId } from "@starcode/contracts";

import { cn } from "../../lib/utils";
import {
  useAccountsUsage,
  useUsageModelAliases,
  useUsageModelAliasWriter,
} from "../../state/usage";
import {
  SettingsPageContainer,
  SettingsSection,
  useRelativeTimeTick,
} from "../settings/settingsLayout";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type AccountLimitRow,
  type CliHistoryProviderRollup,
  cliTotalTokens,
  foldCliModelRows,
  formatCount,
  formatResetCountdown,
  formatTokens,
  formatUsd,
  unpricedShare,
} from "./AccountsUsage.logic";
import { ModelPriceAssignment } from "./ModelPriceAssignment";
import { UsageDailyChart } from "./UsageDailyChart";
import {
  buildUsageDailyChartView,
  DEFAULT_USAGE_CHART_RANGE,
  type UsageChartRange,
} from "./UsageDailyChart.logic";

/** Models past this many fold into one tail row, which keeps a card 3 rows tall. */
const MODEL_ROWS = 3;

/** What a model row needs to offer "price this one as that one", or nothing. */
interface PricingHandles {
  readonly priceableByProvider: ReadonlyMap<CliUsageProvider, ReadonlyArray<string>>;
  readonly pendingModel: string | null;
  readonly onAssign:
    | ((input: {
        readonly provider: CliUsageProvider;
        readonly model: string;
        readonly pricedAs: string | null;
      }) => void)
    | null;
}

const NO_PRICING: PricingHandles = {
  priceableByProvider: new Map(),
  pendingModel: null,
  onAssign: null,
};

/**
 * The CLI each figure was read out of, and where its store lives. Naming the
 * directory is what makes the footer's claim checkable.
 */
const CLI_PROVIDER_META = {
  claude: { label: "Claude Code", driver: "claudeAgent", home: "~/.claude" },
  codex: { label: "Codex", driver: "codex", home: "~/.codex" },
} as const satisfies Record<
  CliUsageProvider,
  { readonly label: string; readonly driver: string; readonly home: string }
>;

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

/**
 * The track a bar gets when there is no figure to plot — an unpriced model, or
 * a window the provider has not reported. Striped rather than empty, because a
 * bar at zero reads as "plenty left" or "this one was free".
 */
const UNKNOWN_TRACK =
  "bg-[repeating-linear-gradient(45deg,var(--color-muted)_0px,var(--color-muted)_3px,transparent_3px,transparent_6px)]";

function ModelRows({
  provider,
  models,
  pricing,
}: {
  provider: CliUsageProvider;
  models: CliHistoryProviderRollup["models"];
  pricing: PricingHandles;
}) {
  const { rows, shareBasis } = foldCliModelRows(models, MODEL_ROWS);
  if (rows.length === 0) return null;
  const priceable = pricing.priceableByProvider.get(provider) ?? [];

  return (
    <div className="grid gap-1">
      {rows.map((row) => {
        const percent = Math.round(row.share * 100);
        return (
          <div key={row.model} className="flex items-center gap-2 text-[11px]">
            <span className="w-24 shrink-0 truncate text-muted-foreground" title={row.model}>
              {row.model}
            </span>
            {row.priced ? (
              <div
                className="h-1.5 min-w-[2rem] flex-1 overflow-hidden rounded-full bg-muted"
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
              <div className={cn("h-1.5 min-w-[2rem] flex-1 rounded-full", UNKNOWN_TRACK)} />
            )}
            <span className="w-14 shrink-0 text-right tabular-nums text-foreground">
              {row.priced ? (
                formatUsd(row.totals.costUsd)
              ) : (
                <span className="text-muted-foreground/60">no price</span>
              )}
            </span>
            {pricing.onAssign !== null &&
            row.assignable &&
            (!row.priced || row.pricedAs !== null) ? (
              <ModelPriceAssignment
                model={row.model}
                onAssign={pricing.onAssign}
                pending={pricing.pendingModel === row.model}
                priceable={priceable}
                pricedAs={row.pricedAs}
                provider={provider}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ProviderCard({
  rollup,
  shareOfCost,
  pending,
  pricing,
}: {
  rollup: CliHistoryProviderRollup;
  /** 0-1 of the fleet's 30-day cost, or null when nothing is priced. */
  shareOfCost: number | null;
  pending: boolean;
  pricing: PricingHandles;
}) {
  const meta = CLI_PROVIDER_META[rollup.provider];
  const totals = rollup.windows.last30Days;

  return (
    <div className="rounded-xl border border-border/60 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <DriverIcon driver={meta.driver} className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{meta.label}</span>
        </span>
        {shareOfCost === null ? null : (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
            {Math.round(shareOfCost * 100)}%
          </span>
        )}
      </div>

      {pending ? (
        <p className="pt-1.5 text-2xl font-normal text-muted-foreground/60">computing…</p>
      ) : (
        <p className="pt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {formatUsd(totals.costUsd)}
        </p>
      )}
      <p className="pt-0.5 text-[11px] tabular-nums text-muted-foreground/60">
        {pending
          ? "—"
          : `${formatCount(totals.messages)} msg · ${formatTokens(cliTotalTokens(totals))} tok`}
      </p>

      <div className="pt-2.5">
        <ModelRows models={rollup.models} pricing={pricing} provider={rollup.provider} />
      </div>
    </div>
  );
}

function ProviderGrid({
  providers,
  totalCostUsd,
  pending,
  pricing,
}: {
  providers: ReadonlyArray<CliHistoryProviderRollup>;
  totalCostUsd: number;
  pending: boolean;
  pricing: PricingHandles;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 px-3 pt-1 sm:px-4",
        providers.length > 1 ? "sm:grid-cols-2" : "sm:grid-cols-1",
      )}
    >
      {providers.map((rollup) => (
        <ProviderCard
          key={rollup.provider}
          pending={pending}
          pricing={pricing}
          rollup={rollup}
          shareOfCost={totalCostUsd === 0 ? null : rollup.windows.last30Days.costUsd / totalCostUsd}
        />
      ))}
    </div>
  );
}

/**
 * The grid, wired to one machine's alias registry.
 *
 * Aliases are machine-local — each server prices its own store — while this
 * page aggregates every machine into one figure. Rather than invent a fleet
 * write that would have to fan out and could half-fail, the affordance is
 * offered only when there is exactly one machine to write to, which is the
 * case where "price this model as that one" has an unambiguous target.
 */
function ProviderGridWithPricing({
  environmentId,
  ...rest
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<CliHistoryProviderRollup>;
  totalCostUsd: number;
  pending: boolean;
}) {
  const catalog = useUsageModelAliases(environmentId);
  const writer = useUsageModelAliasWriter(environmentId);
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  const priceableByProvider = useMemo(() => {
    const map = new Map<CliUsageProvider, ReadonlyArray<string>>();
    for (const entry of catalog?.priceable ?? []) map.set(entry.provider, entry.models);
    return map;
  }, [catalog]);

  const onAssign = useCallback(
    (input: {
      readonly provider: CliUsageProvider;
      readonly model: string;
      readonly pricedAs: string | null;
    }) => {
      setPendingModel(input.model);
      void writer.assign(input).finally(() => {
        setPendingModel(null);
      });
    },
    [writer],
  );

  return (
    <ProviderGrid
      {...rest}
      pricing={{
        priceableByProvider,
        pendingModel,
        // No catalog means the machine never answered the alias route — an
        // older server. The affordance is withheld rather than offered and
        // then refused.
        onAssign: catalog === null ? null : onAssign,
      }}
    />
  );
}

function LimitRow({
  row,
  nowMs,
  showMachine,
}: {
  row: AccountLimitRow;
  nowMs: number;
  showMachine: boolean;
}) {
  const percent = row.peakUsedPercent;
  const countdown = formatResetCountdown(row.resetsAt, nowMs);
  const name = showMachine ? `${row.displayName} · ${row.machineLabel}` : row.displayName;

  return (
    <div className="flex items-center gap-2 text-xs">
      <DriverIcon driver={row.driver} className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className="w-32 shrink-0 truncate text-muted-foreground"
        title={row.planLabel === null ? name : `${name} · ${row.planLabel}`}
      >
        {name}
      </span>
      {percent === null ? (
        <div className={cn("h-1.5 min-w-[2rem] flex-1 rounded-full", UNKNOWN_TRACK)} />
      ) : (
        <div
          className="h-1.5 min-w-[2rem] flex-1 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label={`${row.displayName} allowance used`}
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn("h-full rounded-full transition-[width]", usageBarTone(percent))}
            style={{ width: `${Math.max(percent, 1)}%` }}
          />
        </div>
      )}
      <span
        className={cn(
          "w-9 shrink-0 text-right tabular-nums",
          percent === null
            ? "text-muted-foreground/50"
            : percent >= 90
              ? "text-destructive-foreground"
              : "text-foreground",
        )}
      >
        {percent === null ? "—" : `${Math.round(percent)}%`}
      </span>
      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground/60">
        {countdown ?? (percent === null ? "no data" : "")}
      </span>
    </div>
  );
}

/**
 * The one caveat that must never be swallowed: a model with no vendored rate
 * still contributes tokens, so the dollar figure beside it is a floor. Kept as
 * a badge with the arithmetic in a tooltip rather than a paragraph, because it
 * is a qualifier on a number, not a section of the page.
 */
function FloorBadge({ totals }: { totals: CliUsageTotals }) {
  const share = unpricedShare(totals);
  if (totals.unpricedMessages === 0 || share === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant="warning" size="sm">
            a floor
          </Badge>
        }
      />
      <TooltipPopup side="bottom">
        {formatCount(totals.unpricedMessages)} of {formatCount(totals.messages)} messages (
        {Math.round(share * 100)}%) ran on models with no known price. Their tokens are counted
        here; their cost is not.
      </TooltipPopup>
    </Tooltip>
  );
}

export function AccountsUsagePanel() {
  const view = useAccountsUsage();
  // Reset countdowns are minute-resolution; a per-minute tick is enough and
  // keeps this panel off the per-second render path.
  const nowMs = useRelativeTimeTick(60_000);
  const [range, setRange] = useState<UsageChartRange>(DEFAULT_USAGE_CHART_RANGE);
  const chart = useMemo(() => buildUsageDailyChartView(view.groups, range), [view.groups, range]);

  const history = view.cliHistory;
  const fleetWindow = history.windows.last30Days;
  // Sorted for the page rather than by all-time cost: the card on the left
  // should be the one that dominates the window being shown.
  const providers = [...history.providers].sort(
    (left, right) =>
      right.windows.last30Days.costUsd - left.windows.last30Days.costUsd ||
      right.windows.last30Days.messages - left.windows.last30Days.messages ||
      left.provider.localeCompare(right.provider),
  );
  const reportingMachines = view.groups.filter((group) => group.cliHistory.reported);
  const soleMachine = reportingMachines.length === 1 ? reportingMachines[0] : undefined;
  const showMachine = view.groups.length > 1;

  const gridProps = {
    providers,
    totalCostUsd: fleetWindow.costUsd,
    pending: history.pending,
  };

  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection
        title="Usage"
        headerAction={
          history.scanning ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
              <LoaderIcon className="size-3.5 animate-spin" />
              scanning
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
              <RefreshCwIcon className="size-3.5" />
              every 30s
            </span>
          )
        }
      >
        <div className="px-3 sm:px-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {history.pending || !history.reported ? (
              <p className="text-4xl font-normal tracking-tight text-muted-foreground/60">
                {history.reported ? "computing…" : "—"}
              </p>
            ) : (
              <p className="text-4xl font-semibold tabular-nums tracking-tight text-foreground">
                {formatUsd(fleetWindow.costUsd)}
              </p>
            )}
            {history.costIsFloor ? <FloorBadge totals={fleetWindow} /> : null}
          </div>
          <p className="pt-1 text-[13px] leading-[1.45] text-muted-foreground/80">
            Claude Code + Codex · last 30 days · {view.accountCount}{" "}
            {view.accountCount === 1 ? "account" : "accounts"} on {view.groups.length}{" "}
            {view.groups.length === 1 ? "machine" : "machines"}
          </p>
        </div>

        {chart.reported ? (
          <UsageDailyChart onRangeChange={setRange} range={range} view={chart} />
        ) : null}

        {view.groups.length === 0 ? (
          <p className="px-3 pt-1 text-[13px] text-muted-foreground/80 sm:px-4">
            No machines are connected yet.
          </p>
        ) : !history.reported ? (
          <p className="px-3 pt-1 text-[13px] text-muted-foreground/80 sm:px-4">
            No connected machine reports CLI usage yet — its server may predate the usage scan.
          </p>
        ) : providers.length === 0 && !history.pending ? (
          <p className="px-3 pt-1 text-[13px] text-muted-foreground/80 sm:px-4">
            No Claude Code or Codex history found on any connected machine.
          </p>
        ) : soleMachine === undefined ? (
          <ProviderGrid {...gridProps} pricing={NO_PRICING} />
        ) : (
          <ProviderGridWithPricing {...gridProps} environmentId={soleMachine.environmentId} />
        )}

        {history.failed ? (
          <p className="flex items-center gap-1.5 px-3 pt-1 text-xs text-destructive-foreground sm:px-4">
            <CircleAlertIcon className="size-3.5 shrink-0" />
            At least one machine could not read its CLI session stores, so these totals are
            incomplete.
          </p>
        ) : null}
      </SettingsSection>

      {view.limitRows.length > 0 ? (
        <SettingsSection title="Limits">
          <div className="grid gap-x-8 gap-y-1.5 px-3 sm:grid-cols-2 sm:px-4">
            {view.limitRows.map((row) => (
              <LimitRow
                key={`${row.machineLabel}/${row.instanceId}`}
                row={row}
                nowMs={nowMs}
                showMachine={showMachine}
              />
            ))}
          </div>
        </SettingsSection>
      ) : null}

      <p className="flex flex-wrap items-center gap-x-1.5 px-3 text-[11px] leading-[1.5] text-muted-foreground/60 sm:px-4">
        <InfoIcon className="size-3.5 shrink-0" />
        <span>
          Read from <span className="font-mono">~/.claude</span> and{" "}
          <span className="font-mono">~/.codex</span> on {history.machines}{" "}
          {history.machines === 1 ? "machine" : "machines"} · {formatCount(history.filesScanned)}{" "}
          session files · spend covers Claude Code and Codex only; other providers appear under
          Limits.
          {view.mixedDays ? " These machines are in different time zones." : ""}
        </span>
      </p>
    </SettingsPageContainer>
  );
}
