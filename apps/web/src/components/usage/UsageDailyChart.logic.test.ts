import { describe, expect, it } from "vite-plus/test";

import type { CliProviderUsage, CliUsageProvider, CliUsageTotals } from "@starcode/contracts";
import { EMPTY_CLI_USAGE_TOTALS, EMPTY_USAGE_TOTALS } from "@starcode/contracts";

import type { AccountsUsageEnvironmentGroup } from "./AccountsUsage.logic";
import { EMPTY_CLI_HISTORY_MACHINE_VIEW, EMPTY_CLI_USAGE_WINDOWS } from "./AccountsUsage.logic";
import {
  buildUsageDailyChartView,
  formatChartDayLabel,
  usageChartAxisTicks,
} from "./UsageDailyChart.logic";

const totals = (fields: Partial<CliUsageTotals>): CliUsageTotals => ({
  ...EMPTY_CLI_USAGE_TOTALS,
  ...fields,
});

const providerUsage = (
  provider: CliUsageProvider,
  days: ReadonlyArray<{ day: string; totals: CliUsageTotals }> | undefined,
  last30Days: CliUsageTotals = EMPTY_CLI_USAGE_TOTALS,
): CliProviderUsage =>
  ({
    provider,
    allTime: last30Days,
    last30Days,
    last7Days: EMPTY_CLI_USAGE_TOTALS,
    today: EMPTY_CLI_USAGE_TOTALS,
    models: [],
    ...(days === undefined ? {} : { days }),
    firstDay: null,
    lastDay: null,
    sessionFiles: 1,
  }) as CliProviderUsage;

const machine = (input: {
  readonly label?: string;
  readonly localDay?: string | null;
  readonly reported?: boolean;
  readonly providers?: ReadonlyArray<CliProviderUsage>;
}): AccountsUsageEnvironmentGroup =>
  ({
    environmentId: (input.label ?? "mac") as AccountsUsageEnvironmentGroup["environmentId"],
    label: input.label ?? "mac",
    timeZone: "America/Los_Angeles",
    localDay: input.localDay === undefined ? "2026-07-26" : input.localDay,
    usageAvailable: true,
    configAvailable: true,
    accounts: [],
    lastHour: EMPTY_USAGE_TOTALS,
    lastHourReported: false,
    dormantAccounts: [],
    today: {
      turns: 0,
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    week: {
      turns: 0,
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    cliHistory: {
      ...EMPTY_CLI_HISTORY_MACHINE_VIEW,
      reported: input.reported ?? true,
      status: "ready",
      providers: input.providers ?? [],
      windows: EMPTY_CLI_USAGE_WINDOWS,
    },
  }) as AccountsUsageEnvironmentGroup;

describe("buildUsageDailyChartView", () => {
  it("reports nothing when no machine has CLI history", () => {
    const view = buildUsageDailyChartView([machine({ reported: false })], 30);
    expect(view.reported).toBe(false);
    expect(view.days).toHaveLength(0);
  });

  it("fills the gaps between reported days so the axis is dense", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          providers: [
            providerUsage("codex", [
              { day: "2026-07-24", totals: totals({ costUsd: 4, messages: 2 }) },
              { day: "2026-07-26", totals: totals({ costUsd: 6, messages: 3 }) },
            ]),
          ],
        }),
      ],
      7,
    );
    expect(view.days).toHaveLength(7);
    expect(view.days.map((day) => day.day)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]);
    // The 25th reported nothing, so it is a real zero rather than absent.
    expect(view.days[5]?.costUsd).toBe(0);
    expect(view.days[5]?.messages).toBe(0);
    expect(view.days[5]?.unpricedOnly).toBe(false);
  });

  it("crosses a month boundary without losing a day", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          localDay: "2026-08-02",
          providers: [
            providerUsage("codex", [{ day: "2026-08-02", totals: totals({ costUsd: 1 }) }]),
          ],
        }),
      ],
      7,
    );
    expect(view.days.map((day) => day.day)).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  it("crosses a leap day", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          localDay: "2028-03-01",
          providers: [
            providerUsage("codex", [{ day: "2028-03-01", totals: totals({ costUsd: 1 }) }]),
          ],
        }),
      ],
      7,
    );
    expect(view.days[5]?.day).toBe("2028-02-29");
  });

  it("sums the same day across two machines", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          label: "mac",
          providers: [
            providerUsage("codex", [
              { day: "2026-07-26", totals: totals({ costUsd: 4, messages: 2 }) },
            ]),
          ],
        }),
        machine({
          label: "box",
          providers: [
            providerUsage("codex", [
              { day: "2026-07-26", totals: totals({ costUsd: 6, messages: 5 }) },
            ]),
          ],
        }),
      ],
      7,
    );
    const last = view.days.at(-1);
    expect(last?.costUsd).toBe(10);
    expect(last?.messages).toBe(7);
    expect(last?.segments).toHaveLength(1);
    expect(last?.segments[0]?.costUsd).toBe(10);
    expect(view.machines).toBe(2);
  });

  it("stacks the two providers costliest first", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          providers: [
            providerUsage("claude", [{ day: "2026-07-26", totals: totals({ costUsd: 2 }) }]),
            providerUsage("codex", [{ day: "2026-07-26", totals: totals({ costUsd: 9 }) }]),
          ],
        }),
      ],
      7,
    );
    expect(view.providers).toEqual(["codex", "claude"]);
    expect(view.days.at(-1)?.segments.map((segment) => segment.provider)).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("marks a day whose only messages were unpriced", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          providers: [
            providerUsage("codex", [
              {
                day: "2026-07-26",
                totals: totals({ costUsd: 0, messages: 400, unpricedMessages: 400 }),
              },
            ]),
          ],
        }),
      ],
      7,
    );
    const last = view.days.at(-1);
    expect(last?.unpricedOnly).toBe(true);
    expect(last?.unpricedMessages).toBe(400);
    expect(view.unpricedMessages).toBe(400);
  });

  it("does not mark a day that spent something as unpriced-only", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          providers: [
            providerUsage("codex", [
              {
                day: "2026-07-26",
                totals: totals({ costUsd: 3, messages: 400, unpricedMessages: 399 }),
              },
            ]),
          ],
        }),
      ],
      7,
    );
    expect(view.days.at(-1)?.unpricedOnly).toBe(false);
  });

  it("scales shares against the costliest day in the window", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          providers: [
            providerUsage("codex", [
              { day: "2026-07-25", totals: totals({ costUsd: 5 }) },
              { day: "2026-07-26", totals: totals({ costUsd: 20 }) },
            ]),
          ],
        }),
      ],
      7,
    );
    expect(view.maxCostUsd).toBe(20);
    expect(view.days.at(-1)?.share).toBe(1);
    expect(view.days.at(-2)?.share).toBe(0.25);
  });

  it("takes the right edge from the machine's own day, not the viewer's", () => {
    // The machine says it is still the 24th; the chart must not invent a 26th.
    const view = buildUsageDailyChartView(
      [
        machine({
          localDay: "2026-07-24",
          providers: [
            providerUsage("codex", [{ day: "2026-07-24", totals: totals({ costUsd: 1 }) }]),
          ],
        }),
      ],
      7,
    );
    expect(view.days.at(-1)?.day).toBe("2026-07-24");
  });

  it("flags a machine that reports totals but no daily series", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          label: "mac",
          providers: [
            providerUsage("codex", [{ day: "2026-07-26", totals: totals({ costUsd: 1 }) }]),
          ],
        }),
        machine({
          label: "old",
          providers: [providerUsage("claude", undefined, totals({ costUsd: 99, messages: 12 }))],
        }),
      ],
      7,
    );
    expect(view.partial).toBe(true);
    // Its spend is deliberately absent from the bars rather than guessed at.
    expect(view.totalCostUsd).toBe(1);
  });

  it("does not flag an old server that had nothing to report", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          label: "mac",
          providers: [
            providerUsage("codex", [{ day: "2026-07-26", totals: totals({ costUsd: 1 }) }]),
          ],
        }),
        machine({ label: "quiet", providers: [providerUsage("claude", undefined)] }),
      ],
      7,
    );
    expect(view.partial).toBe(false);
  });

  it("returns thirty columns for the thirty-day range", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          providers: [
            providerUsage("codex", [{ day: "2026-07-26", totals: totals({ costUsd: 1 }) }]),
          ],
        }),
      ],
      30,
    );
    expect(view.days).toHaveLength(30);
    expect(view.days[0]?.day).toBe("2026-06-27");
  });

  it("ignores a malformed day rather than shifting the axis", () => {
    const view = buildUsageDailyChartView(
      [
        machine({
          providers: [
            providerUsage("codex", [
              { day: "not-a-day", totals: totals({ costUsd: 500 }) },
              { day: "2026-07-26", totals: totals({ costUsd: 1 }) },
            ]),
          ],
        }),
      ],
      7,
    );
    expect(view.days.at(-1)?.day).toBe("2026-07-26");
    expect(view.maxCostUsd).toBe(1);
  });
});

describe("formatChartDayLabel", () => {
  it("formats from the parts, with no leading zero on the date", () => {
    expect(formatChartDayLabel("2026-07-06")).toBe("Jul 6");
    expect(formatChartDayLabel("2026-12-31")).toBe("Dec 31");
  });

  it("returns anything unparseable unchanged", () => {
    expect(formatChartDayLabel("whenever")).toBe("whenever");
  });
});

describe("usageChartAxisTicks", () => {
  const daysOf = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      day: `2026-07-${`${index + 1}`.padStart(2, "0")}`,
      label: "",
      costUsd: 0,
      messages: 0,
      unpricedMessages: 0,
      tokens: 0,
      segments: [],
      unpricedOnly: false,
      share: 0,
    }));

  it("always ticks the rightmost column", () => {
    const ticks = usageChartAxisTicks(daysOf(30));
    expect(ticks.has("2026-07-30")).toBe(true);
  });

  it("ticks every day in a seven-day window", () => {
    expect(usageChartAxisTicks(daysOf(7)).size).toBe(7);
  });

  it("thins a thirty-day window to weekly ticks", () => {
    expect(usageChartAxisTicks(daysOf(30)).size).toBe(5);
  });
});
