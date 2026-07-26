/**
 * Daily CLI spend, one bar per day.
 *
 * The four cumulative tiles under this chart answer "how much"; this answers
 * "when", which is the question a month of flat totals cannot. It reads the
 * same per-provider day buckets every machine reports and stacks them, so a
 * column's height is the fleet's spend that day and its bands are which CLI
 * spent it.
 *
 * Deliberately austere. No gridlines beyond a single hairline baseline, no
 * y-axis, no values printed on the bars — the shape is the message, and the
 * number for one day is one hover away. The tooltip is a single absolutely
 * positioned element moved between columns rather than thirty portalled
 * popups, which is what keeps a thirty-bar hover cheap.
 *
 * The one thing it must never do is draw a day that ran on unpriceable models
 * as an empty $0 column. Those are hatched and hollow, and the tooltip says
 * how many messages are behind the gap — which is also the pitch for assigning
 * the model a price in the rows below.
 *
 * @module UsageDailyChart
 */
import { useState } from "react";

import type { CliUsageProvider } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { formatCount, formatTokens, formatUsd } from "./AccountsUsage.logic";
import {
  type UsageChartDay,
  type UsageChartRange,
  type UsageDailyChartView,
  USAGE_CHART_RANGES,
  usageChartAxisTicks,
} from "./UsageDailyChart.logic";

/**
 * Hatching, reused verbatim from the rate-limit bars' "not reported" track.
 * Same meaning in both places — a quantity that exists and has no figure — so
 * it is the same mark.
 */
const HATCH_CLASS =
  "bg-[repeating-linear-gradient(45deg,var(--color-muted-foreground)_0px,var(--color-muted-foreground)_2px,transparent_2px,transparent_5px)]";

const PROVIDER_LABEL: Record<CliUsageProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** Semantic tokens, declared per theme in `starcode-theme.css` section 2. */
const PROVIDER_SERIES_VAR: Record<CliUsageProvider, string> = {
  claude: "var(--usage-series-claude)",
  codex: "var(--usage-series-codex)",
};

/**
 * How tall a hollow "no known price" column is drawn.
 *
 * A fixed fraction rather than anything derived from tokens: the y-axis is
 * dollars, and giving an unpriced day a height computed from its messages
 * would put two different units on one scale. It is a marker that says "there
 * was activity here", not a measurement.
 */
const UNPRICED_COLUMN_SHARE = 0.14;

/** Under this, a real bar is a smudge; the floor keeps a spent day visible. */
const MIN_VISIBLE_SHARE = 0.02;

function RangeToggle({
  range,
  onChange,
}: {
  range: UsageChartRange;
  onChange: (next: UsageChartRange) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5">
      {USAGE_CHART_RANGES.map((option) => (
        <button
          aria-pressed={option === range}
          className={cn(
            "rounded-[0.4rem] px-2 py-0.5 text-[11px] tabular-nums transition-colors",
            option === range
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground/70 hover:text-foreground",
          )}
          key={option}
          onClick={() => {
            onChange(option);
          }}
          type="button"
        >
          {option}d
        </button>
      ))}
    </div>
  );
}

/**
 * The hovered day's numbers, on one line in the chart's header.
 *
 * A fixed readout rather than a floating popup, and deliberately so. The plot
 * is ~112px tall inside a settings panel: a tooltip over it hides the bars it
 * describes, and one above it lands on the section heading. Pinning it to the
 * header costs a little eye travel and buys a readout that never clips, never
 * shifts the layout, and is in the same place for every column — while the
 * dimming of the other bars is what says *which* column is being read.
 */
function DayReadout({
  day,
  providers,
}: {
  day: UsageChartDay;
  providers: ReadonlyArray<CliUsageProvider>;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
      <span className="font-medium tabular-nums text-foreground">{day.label}</span>
      {day.messages === 0 ? (
        <span className="text-muted-foreground/60">no messages</span>
      ) : (
        <>
          {/* A day that ran entirely on unpriceable models leads with what is
              true — that there is no price — rather than with "$0.00", which
              is the exact misreading this column exists to prevent. */}
          {day.unpricedOnly ? (
            <span className="text-warning-foreground">no known price</span>
          ) : (
            <>
              <span className="tabular-nums text-foreground">{formatUsd(day.costUsd)}</span>
              {providers.map((provider) => {
                const segment = day.segments.find((entry) => entry.provider === provider);
                // A provider that spent nothing this day is not worth a swatch.
                if (segment === undefined || segment.costUsd <= 0) return null;
                return (
                  <span
                    className="flex items-center gap-1 tabular-nums text-muted-foreground/70"
                    key={provider}
                  >
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: PROVIDER_SERIES_VAR[provider] }}
                    />
                    {formatUsd(segment.costUsd)}
                  </span>
                );
              })}
            </>
          )}
          <span className="tabular-nums text-muted-foreground/60">
            {formatCount(day.messages)} msg · {formatTokens(day.tokens)} tok
          </span>
          {day.unpricedMessages > 0 ? (
            <span className="tabular-nums text-warning-foreground">
              {day.unpricedOnly
                ? `${formatCount(day.unpricedMessages)} unpriced`
                : `${formatCount(day.unpricedMessages)} unpriced, not in this bar`}
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

function Bars({
  view,
  activeDay,
  onActiveDayChange,
}: {
  view: UsageDailyChartView;
  activeDay: string | null;
  onActiveDayChange: (day: string | null) => void;
}) {
  const ticks = usageChartAxisTicks(view.days);

  return (
    <div>
      <div
        className="flex h-28 items-end gap-px"
        onPointerLeave={() => {
          onActiveDayChange(null);
        }}
      >
        {view.days.map((day) => {
          const isActive = day.day === activeDay;
          const height = day.unpricedOnly
            ? UNPRICED_COLUMN_SHARE
            : day.costUsd > 0
              ? Math.max(day.share, MIN_VISIBLE_SHARE)
              : 0;
          return (
            <button
              aria-label={`${day.label}: ${formatUsd(day.costUsd)}${
                day.unpricedMessages > 0
                  ? `, ${formatCount(day.unpricedMessages)} messages with no known price`
                  : ""
              }`}
              className="group flex h-full min-w-0 flex-1 cursor-default items-end rounded-t-[3px] focus-visible:outline-none"
              data-usage-chart-day={day.day}
              data-usage-chart-unpriced={day.unpricedOnly ? "true" : undefined}
              key={day.day}
              onBlur={() => {
                onActiveDayChange(null);
              }}
              onFocus={() => {
                onActiveDayChange(day.day);
              }}
              onPointerEnter={() => {
                onActiveDayChange(day.day);
              }}
              type="button"
            >
              <span
                className={cn(
                  "flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity",
                  // Dimming the rest rather than brightening one keeps the
                  // hovered column's colour honest against the legend. Held at
                  // 60%: enough to pick the hovered column out, not so much
                  // that the shape of the month stops being readable.
                  activeDay !== null && !isActive ? "opacity-60" : "opacity-100",
                  day.unpricedOnly
                    ? cn(HATCH_CLASS, "opacity-40 ring-1 ring-muted-foreground/40 ring-inset")
                    : "",
                )}
                style={{ height: `${Math.max(height, 0) * 100}%` }}
              >
                {day.unpricedOnly
                  ? null
                  : day.segments.map((segment) =>
                      segment.costUsd <= 0 ? null : (
                        <span
                          key={segment.provider}
                          style={{
                            backgroundColor: PROVIDER_SERIES_VAR[segment.provider],
                            height: `${(segment.costUsd / day.costUsd) * 100}%`,
                          }}
                        />
                      ),
                    )}
              </span>
            </button>
          );
        })}
      </div>

      {/* The only rule on the plot. Anything heavier competes with the bars. */}
      <div className="h-px w-full bg-border" />

      {/* Labels are centred on their column but allowed to overflow it: a
          column is a few pixels wide in a thirty-day window, and clipping
          "Jun 28" onto two lines is worse than letting it sit over its
          neighbours' empty slots. */}
      <div aria-hidden className="flex gap-px pt-1">
        {view.days.map((day) => (
          <span className="relative min-w-0 flex-1" key={day.day}>
            {ticks.has(day.day) ? (
              <span className="absolute inset-x-0 top-0 flex justify-center">
                <span className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground/60">
                  {day.label}
                </span>
              </span>
            ) : null}
          </span>
        ))}
      </div>
      {/* Reserves the label row's height, since the labels themselves are
          absolutely positioned out of flow. */}
      <div aria-hidden className="h-3.5" />
    </div>
  );
}

export function UsageDailyChart({
  view,
  range,
  onRangeChange,
}: {
  view: UsageDailyChartView;
  range: UsageChartRange;
  onRangeChange: (next: UsageChartRange) => void;
}) {
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const active = view.days.find((day) => day.day === activeDay) ?? null;
  const hasHatchedBar = view.days.some((day) => day.unpricedOnly);

  return (
    <div className="px-3 sm:px-4" data-testid="usage-daily-chart">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h4 className="shrink-0 text-sm font-medium text-foreground">Daily spend</h4>
          {active === null ? (
            <span className="text-xs tabular-nums text-muted-foreground/60">
              {formatUsd(view.totalCostUsd)} over {range} days
            </span>
          ) : (
            <DayReadout day={active} providers={view.providers} />
          )}
        </div>
        <RangeToggle onChange={onRangeChange} range={range} />
      </div>

      {view.days.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground/70">
          No CLI usage in this window.
        </p>
      ) : (
        <Bars activeDay={activeDay} onActiveDayChange={setActiveDay} view={view} />
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-[11px] text-muted-foreground/70">
        {view.providers.map((provider) => (
          <span className="flex items-center gap-1.5" key={provider}>
            <span
              aria-hidden
              className="size-2 rounded-[2px]"
              style={{ backgroundColor: PROVIDER_SERIES_VAR[provider] }}
            />
            {PROVIDER_LABEL[provider]}
          </span>
        ))}
        {/* Only when a hatched column is actually on screen. A legend entry
            for a mark that is nowhere in the plot sends a reader hunting.
            Unpriced messages on days that also spent something are reported
            in the hover readout and in the note below the tiles instead. */}
        {hasHatchedBar ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-[2px] opacity-50 ring-1 ring-muted-foreground/40 ring-inset",
                HATCH_CLASS,
              )}
            />
            No known price
          </span>
        ) : null}
        {view.machines > 1 ? (
          <span className="text-muted-foreground/60">
            {view.machines} machines, each in its own midnight
          </span>
        ) : null}
      </div>

      {view.partial ? (
        <p className="pt-1 text-[11px] text-warning-foreground">
          At least one machine's server reports totals but no daily breakdown, so its spend is in
          the tiles above and missing from these bars.
        </p>
      ) : null}
    </div>
  );
}
