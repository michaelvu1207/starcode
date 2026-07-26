/**
 * The daily-spend chart's view model.
 *
 * Turns every reporting machine's per-provider day buckets into one dense
 * series the bar chart can render without deriving anything itself.
 *
 * Three rules shape it.
 *
 * **The axis is dense, the data is sparse.** A machine only reports days that
 * carry usage, but a chart with the empty days squeezed out is a chart that
 * lies about rhythm — four heavy days in a row look identical to four heavy
 * days across a fortnight. So the axis is built from `today` backwards and
 * days with no usage are real zero-height columns.
 *
 * **Day strings are never parsed into a `Date`.** They arrive as `YYYY-MM-DD`
 * already resolved in the *reporting* machine's zone; constructing a local
 * `Date` from one re-interprets it in the viewer's zone and shifts the whole
 * axis by a day whenever the two disagree. Arithmetic here is UTC-based on the
 * parts, which is zone-free by construction.
 *
 * **A day with no dollars is not a day with no usage.** Unpriced models
 * contribute tokens and no cost, and on a machine living on preview models
 * that is most of the history. Those days carry `unpricedOnly`, and the chart
 * draws them as something other than a $0 gap.
 *
 * @module UsageDailyChartLogic
 */
import type { CliUsageProvider, CliUsageTotals } from "@t3tools/contracts";

import type { AccountsUsageEnvironmentGroup } from "./AccountsUsage.logic";

/** The two windows the toggle offers, in days including today. */
export const USAGE_CHART_RANGES = [30, 7] as const;
export type UsageChartRange = (typeof USAGE_CHART_RANGES)[number];

export const DEFAULT_USAGE_CHART_RANGE: UsageChartRange = 30;

/** One provider's contribution to one day. */
export interface UsageChartSegment {
  readonly provider: CliUsageProvider;
  readonly costUsd: number;
  readonly messages: number;
  readonly unpricedMessages: number;
}

export interface UsageChartDay {
  /** `YYYY-MM-DD`, as the reporting machine resolved it. */
  readonly day: string;
  /** "Jul 26" — for the axis and the tooltip's heading. */
  readonly label: string;
  readonly costUsd: number;
  readonly messages: number;
  readonly unpricedMessages: number;
  readonly tokens: number;
  /** Costliest first, so a stack reads top-down in the order the legend does. */
  readonly segments: ReadonlyArray<UsageChartSegment>;
  /**
   * The day carries messages but no dollars, because every model that ran was
   * one the rate table has never heard of. Rendered as a hollow hatched column
   * rather than as nothing: "we do not know" and "you spent nothing" are
   * different claims and this chart must not conflate them.
   */
  readonly unpricedOnly: boolean;
  /** 0-1 against the costliest day in the window. */
  readonly share: number;
}

export interface UsageDailyChartView {
  /** False when no connected machine reported a daily series at all. */
  readonly reported: boolean;
  readonly range: UsageChartRange;
  readonly days: ReadonlyArray<UsageChartDay>;
  readonly maxCostUsd: number;
  readonly totalCostUsd: number;
  readonly totalMessages: number;
  readonly unpricedMessages: number;
  /** Providers that appear anywhere in the window, costliest first. */
  readonly providers: ReadonlyArray<CliUsageProvider>;
  /** How many machines contributed, for the "four midnights" caveat. */
  readonly machines: number;
  /**
   * At least one machine reported cumulative windows but no daily series —
   * an older server. Its spend is in the tiles above and missing from these
   * bars, which the chart says rather than quietly under-drawing.
   */
  readonly partial: boolean;
}

export const EMPTY_USAGE_DAILY_CHART_VIEW: UsageDailyChartView = {
  reported: false,
  range: DEFAULT_USAGE_CHART_RANGE,
  days: [],
  maxCostUsd: 0,
  totalCostUsd: 0,
  totalMessages: 0,
  unpricedMessages: 0,
  providers: [],
  machines: 0,
  partial: false,
};

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `YYYY-MM-DD` -> UTC epoch ms, or null for anything that is not one. */
function dayToUtcMs(day: string): number | null {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return null;
  const [, year, month, date] = match;
  if (year === undefined || month === undefined || date === undefined) return null;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(date));
  return Number.isNaN(ms) ? null : ms;
}

function utcMsToDay(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const dayOfMonth = `${date.getUTCDate()}`.padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${dayOfMonth}`;
}

/**
 * "Jul 26" for a `YYYY-MM-DD`, formatted from its parts.
 *
 * Exported because the tooltip and the axis must agree, and because the
 * hand-formatting is the whole point — a `toLocaleDateString` here would shift
 * the label into the viewer's zone.
 */
export function formatChartDayLabel(day: string): string {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return day;
  const [, , month, dayOfMonth] = match;
  if (month === undefined || dayOfMonth === undefined) return day;
  const monthName = MONTH_NAMES[Number(month) - 1];
  return monthName === undefined ? day : `${monthName} ${Number(dayOfMonth)}`;
}

const MILLIS_PER_DAY = 86_400_000;

interface MutableDay {
  costUsd: number;
  messages: number;
  unpricedMessages: number;
  tokens: number;
  readonly byProvider: Map<CliUsageProvider, UsageChartSegment>;
}

const emptyMutableDay = (): MutableDay => ({
  costUsd: 0,
  messages: 0,
  unpricedMessages: 0,
  tokens: 0,
  byProvider: new Map(),
});

const tokensOf = (totals: CliUsageTotals): number =>
  totals.inputTokens + totals.outputTokens + totals.cacheWriteTokens + totals.cacheReadTokens;

/**
 * Folds every machine's day buckets into one window.
 *
 * Same-day figures from different machines are summed, which is the one place
 * this view model deliberately blurs a distinction the rest of the panel
 * keeps: two machines in two zones have two midnights, and a fleet chart adds
 * them anyway because "what did the fleet spend on the 24th" is the question
 * being asked. The caption says so when more than one machine contributes.
 */
export function buildUsageDailyChartView(
  groups: ReadonlyArray<AccountsUsageEnvironmentGroup>,
  range: UsageChartRange,
): UsageDailyChartView {
  const reporting = groups.filter((group) => group.cliHistory.reported);
  if (reporting.length === 0) return { ...EMPTY_USAGE_DAILY_CHART_VIEW, range };

  const byDay = new Map<string, MutableDay>();
  const providerCost = new Map<CliUsageProvider, number>();
  let sawSeries = false;
  let partial = false;
  // The right edge of the axis. Taken from the machines' own idea of "today"
  // rather than the viewer's clock, so a browser open past a machine's
  // midnight does not render a phantom empty column.
  let latestDay: string | null = null;

  for (const group of reporting) {
    if (group.localDay !== null && (latestDay === null || group.localDay > latestDay)) {
      latestDay = group.localDay;
    }
    for (const provider of group.cliHistory.providers) {
      const series = provider.days;
      if (series === undefined) {
        // An older server: cumulative windows but no per-day breakdown. Only
        // counts as a gap if it actually had something to break down.
        if (provider.last30Days.messages > 0) partial = true;
        continue;
      }
      sawSeries = true;
      for (const entry of series) {
        if (dayToUtcMs(entry.day) === null) continue;
        if (latestDay === null || entry.day > latestDay) latestDay = entry.day;
        let day = byDay.get(entry.day);
        if (day === undefined) {
          day = emptyMutableDay();
          byDay.set(entry.day, day);
        }
        const previous = day.byProvider.get(provider.provider);
        day.byProvider.set(provider.provider, {
          provider: provider.provider,
          costUsd: (previous?.costUsd ?? 0) + entry.totals.costUsd,
          messages: (previous?.messages ?? 0) + entry.totals.messages,
          unpricedMessages: (previous?.unpricedMessages ?? 0) + entry.totals.unpricedMessages,
        });
        day.costUsd += entry.totals.costUsd;
        day.messages += entry.totals.messages;
        day.unpricedMessages += entry.totals.unpricedMessages;
        day.tokens += tokensOf(entry.totals);
        providerCost.set(
          provider.provider,
          (providerCost.get(provider.provider) ?? 0) + entry.totals.costUsd,
        );
      }
    }
  }

  if (!sawSeries || latestDay === null) {
    return { ...EMPTY_USAGE_DAILY_CHART_VIEW, range, machines: reporting.length, partial };
  }

  const latestMs = dayToUtcMs(latestDay);
  if (latestMs === null) {
    return { ...EMPTY_USAGE_DAILY_CHART_VIEW, range, machines: reporting.length, partial };
  }

  // Costliest provider first so the stack and the legend agree, with the
  // provider name as the tiebreak — two providers at exactly zero must not
  // swap places between renders.
  const orderOf = (provider: CliUsageProvider): number => providerCost.get(provider) ?? 0;
  const providers = [...providerCost.keys()].sort(
    (left, right) => orderOf(right) - orderOf(left) || left.localeCompare(right),
  );

  const days: Array<UsageChartDay> = [];
  let maxCostUsd = 0;
  let totalCostUsd = 0;
  let totalMessages = 0;
  let unpricedMessages = 0;

  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const day = utcMsToDay(latestMs - offset * MILLIS_PER_DAY);
    const folded = byDay.get(day);
    const costUsd = folded?.costUsd ?? 0;
    maxCostUsd = Math.max(maxCostUsd, costUsd);
    totalCostUsd += costUsd;
    totalMessages += folded?.messages ?? 0;
    unpricedMessages += folded?.unpricedMessages ?? 0;
    days.push({
      day,
      label: formatChartDayLabel(day),
      costUsd,
      messages: folded?.messages ?? 0,
      unpricedMessages: folded?.unpricedMessages ?? 0,
      tokens: folded?.tokens ?? 0,
      segments:
        folded === undefined
          ? []
          : providers.flatMap((provider) => {
              const segment = folded.byProvider.get(provider);
              return segment === undefined ? [] : [segment];
            }),
      unpricedOnly: costUsd === 0 && (folded?.messages ?? 0) > 0,
      // Filled below, once the window's maximum is known.
      share: 0,
    });
  }

  return {
    reported: true,
    range,
    days: days.map((day) => ({
      ...day,
      share: maxCostUsd === 0 ? 0 : day.costUsd / maxCostUsd,
    })),
    maxCostUsd,
    totalCostUsd,
    totalMessages,
    unpricedMessages,
    providers,
    machines: reporting.length,
    partial,
  };
}

/**
 * Which days get a written label under the axis.
 *
 * Every seventh column plus the last one, counted from the right, so the
 * rightmost tick is always "today" and the spacing does not drift when the
 * range changes. Returns a set of `YYYY-MM-DD`.
 */
export function usageChartAxisTicks(days: ReadonlyArray<UsageChartDay>): ReadonlySet<string> {
  const ticks = new Set<string>();
  const stride = days.length > 14 ? 7 : days.length > 7 ? 2 : 1;
  for (let index = days.length - 1; index >= 0; index -= stride) {
    const day = days[index];
    if (day !== undefined) ticks.add(day.day);
  }
  return ticks;
}
