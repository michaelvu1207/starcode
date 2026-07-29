import {
  type CliHistoricalUsage,
  type CliProviderUsage,
  type CliUsageModelTotals,
  type CliUsageTotals,
  EMPTY_CLI_USAGE_TOTALS,
  EMPTY_USAGE_TOTALS,
  type EnvironmentId,
  type EnvironmentUsageSnapshot,
  type ServerConfig,
  type ServerProvider,
  type UsageTotals,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAccountsUsageView,
  buildCliHistoryView,
  foldCliModelRows,
  formatCount,
  formatDayRange,
  formatResetCountdown,
  formatTokens,
  formatUsd,
  peakUsedPercent,
  unpricedShare,
} from "./AccountsUsage.logic";

const environmentId = (value: string) => value as EnvironmentId;

const totals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  ...EMPTY_USAGE_TOTALS,
  ...overrides,
});

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: "claude-personal",
    driver: "claudeAgent",
    displayName: "Claude (personal)",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "me@example.com", label: "Max" },
    checkedAt: "2026-07-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as unknown as ServerProvider;

const config = (providers: ReadonlyArray<ServerProvider>): ServerConfig =>
  ({ providers }) as unknown as ServerConfig;

const usage = (overrides: Partial<EnvironmentUsageSnapshot> = {}): EnvironmentUsageSnapshot => ({
  generatedAt: "2026-07-24T18:00:00.000Z",
  timeZone: "America/Los_Angeles",
  today: "2026-07-24",
  instances: [],
  totalsToday: EMPTY_USAGE_TOTALS,
  totalsWeek: EMPTY_USAGE_TOTALS,
  ...overrides,
});

const cliTotals = (overrides: Partial<CliUsageTotals> = {}): CliUsageTotals => ({
  ...EMPTY_CLI_USAGE_TOTALS,
  ...overrides,
});

const cliProvider = (overrides: Partial<CliProviderUsage> = {}): CliProviderUsage => ({
  provider: "claude",
  allTime: cliTotals(),
  last30Days: cliTotals(),
  last7Days: cliTotals(),
  today: cliTotals(),
  models: [],
  firstDay: null,
  lastDay: null,
  sessionFiles: 0,
  ...overrides,
});

const cliHistory = (overrides: Partial<CliHistoricalUsage> = {}): CliHistoricalUsage => ({
  status: "ready",
  computedAt: "2026-07-25T18:00:00.000Z",
  providers: [],
  totals: EMPTY_CLI_USAGE_TOTALS,
  filesScanned: 0,
  ...overrides,
});

/** A provider whose four cumulative windows all carry the same figures. */
const flatProvider = (
  provider: CliProviderUsage["provider"],
  totals: Partial<CliUsageTotals>,
  rest: Partial<CliProviderUsage> = {},
): CliProviderUsage =>
  cliProvider({
    provider,
    allTime: cliTotals(totals),
    last30Days: cliTotals(totals),
    last7Days: cliTotals(totals),
    today: cliTotals(totals),
    ...rest,
  });

const model = (
  name: string,
  costUsd: number,
  overrides: Partial<CliUsageTotals> = {},
  priced = true,
): CliUsageModelTotals => ({
  model: name,
  priced,
  totals: cliTotals({ costUsd, messages: 1, ...overrides }),
});

describe("buildAccountsUsageView", () => {
  it("joins a provider instance to its usage by instance id", () => {
    const view = buildAccountsUsageView([
      {
        environmentId: environmentId("mac"),
        label: "mac",
        config: config([provider()]),
        usage: usage({
          instances: [
            {
              providerInstanceId: "claude-personal" as never,
              driver: "claudeAgent" as never,
              rateLimits: null,
              today: totals({ turns: 3, costUsd: 1.25 }),
              week: totals({ turns: 9, costUsd: 4 }),
              days: [],
              lastTurnAt: "2026-07-24T17:00:00.000Z",
            },
          ],
        }),
      },
    ]);

    const account = view.groups[0]?.accounts[0];
    expect(account?.email).toBe("me@example.com");
    expect(account?.planLabel).toBe("Max");
    expect(account?.today.costUsd).toBe(1.25);
    expect(account?.lastTurnAt).toBe("2026-07-24T17:00:00.000Z");
    expect(view.today.costUsd).toBe(1.25);
    expect(view.accountCount).toBe(1);
  });

  it("keeps a configured instance with no usage yet, at zero", () => {
    const view = buildAccountsUsageView([
      {
        environmentId: environmentId("mac"),
        label: "mac",
        config: config([provider()]),
        usage: usage(),
      },
    ]);

    const account = view.groups[0]?.accounts[0];
    expect(account?.today).toEqual(EMPTY_USAGE_TOTALS);
    expect(account?.orphanedUsage).toBe(false);
  });

  it("surfaces spend recorded against an instance that is no longer configured", () => {
    const view = buildAccountsUsageView([
      {
        environmentId: environmentId("mac"),
        label: "mac",
        config: config([]),
        usage: usage({
          instances: [
            {
              providerInstanceId: "codex-old" as never,
              driver: "codex" as never,
              rateLimits: null,
              today: totals({ turns: 1, costUsd: 0.5 }),
              week: totals({ turns: 1, costUsd: 0.5 }),
              days: [],
              lastTurnAt: null,
            },
          ],
        }),
      },
    ]);

    const account = view.groups[0]?.accounts[0];
    expect(account?.orphanedUsage).toBe(true);
    expect(account?.displayName).toBe("codex-old");
    expect(view.today.costUsd).toBe(0.5);
  });

  it("renders a machine whose usage could not be read, with accounts intact", () => {
    const view = buildAccountsUsageView([
      {
        environmentId: environmentId("laptop"),
        label: "laptop",
        config: config([provider()]),
        usage: null,
      },
    ]);

    const group = view.groups[0];
    expect(group?.usageAvailable).toBe(false);
    expect(group?.timeZone).toBeNull();
    expect(group?.accounts).toHaveLength(1);
    expect(group?.accounts[0]?.email).toBe("me@example.com");
  });

  it("orders machines by label and accounts by display name", () => {
    const view = buildAccountsUsageView([
      {
        environmentId: environmentId("z"),
        label: "simforge1",
        config: config([
          provider({ instanceId: "b" as never, displayName: "Work" }),
          provider({ instanceId: "a" as never, displayName: "Personal" }),
        ]),
        usage: usage(),
      },
      {
        environmentId: environmentId("a"),
        label: "mac",
        config: config([]),
        usage: usage(),
      },
    ]);

    expect(view.groups.map((group) => group.label)).toEqual(["mac", "simforge1"]);
    expect(view.groups[1]?.accounts.map((account) => account.displayName)).toEqual([
      "Personal",
      "Work",
    ]);
  });

  it("flags machines that disagree about which day today is", () => {
    const build = (days: ReadonlyArray<string>) =>
      buildAccountsUsageView(
        days.map((today, index) => ({
          environmentId: environmentId(`env-${index}`),
          label: `env-${index}`,
          config: config([]),
          usage: usage({ today }),
        })),
      );

    expect(build(["2026-07-24", "2026-07-24"]).mixedDays).toBe(false);
    expect(build(["2026-07-24", "2026-07-25"]).mixedDays).toBe(true);
  });

  it("falls back to the rate-limit plan when the auth probe reports none", () => {
    const view = buildAccountsUsageView([
      {
        environmentId: environmentId("mac"),
        label: "mac",
        config: config([
          provider({
            instanceId: "codex-main" as never,
            driver: "codex" as never,
            displayName: "Codex",
            auth: { status: "authenticated" },
          }),
        ]),
        usage: usage({
          instances: [
            {
              providerInstanceId: "codex-main" as never,
              driver: "codex" as never,
              rateLimits: {
                status: "allowed",
                planLabel: "pro",
                windows: [],
                observedAt: "2026-07-24T17:00:00.000Z",
              },
              today: EMPTY_USAGE_TOTALS,
              week: EMPTY_USAGE_TOTALS,
              days: [],
              lastTurnAt: null,
            },
          ],
        }),
      },
    ]);

    expect(view.groups[0]?.accounts[0]?.planLabel).toBe("pro");
  });
});

describe("the trailing-hour fleet rate", () => {
  const hourly = (label: string, totalsLastHour: UsageTotals | undefined, instanceHour = 0) => ({
    environmentId: environmentId(label),
    label,
    config: config([provider()]),
    usage: usage({
      ...(totalsLastHour === undefined ? {} : { totalsLastHour }),
      instances: [
        {
          providerInstanceId: "claude-personal" as never,
          driver: "claudeAgent" as never,
          rateLimits: null,
          today: EMPTY_USAGE_TOTALS,
          week: EMPTY_USAGE_TOTALS,
          ...(totalsLastHour === undefined
            ? {}
            : { lastHour: totals({ turns: instanceHour, costUsd: instanceHour }) }),
          days: [],
          lastTurnAt: null,
        },
      ],
    }),
  });

  it("sums the window across machines", () => {
    const view = buildAccountsUsageView([
      hourly("mac", totals({ turns: 4, costUsd: 2.5, inputTokens: 100 }), 4),
      hourly("linux", totals({ turns: 2, costUsd: 1, outputTokens: 20 }), 2),
    ]);

    expect(view.lastHourReported).toBe(true);
    expect(view.lastHour.costUsd).toBe(3.5);
    expect(view.lastHour.turns).toBe(6);
    expect(view.lastHour.inputTokens).toBe(100);
    expect(view.lastHourMachines).toBe(2);
    expect(view.lastHourActiveAccounts).toBe(2);
  });

  it("leaves a machine that cannot report the window out of the rate", () => {
    const view = buildAccountsUsageView([
      hourly("mac", totals({ turns: 4, costUsd: 2.5 }), 4),
      hourly("old-server", undefined),
    ]);

    expect(view.lastHourMachines).toBe(1);
    expect(view.lastHour.costUsd).toBe(2.5);
    expect(view.groups.find((group) => group.label === "old-server")?.lastHourReported).toBe(false);
  });

  it("stays unreported when no machine knows about the window", () => {
    const view = buildAccountsUsageView([hourly("mac", undefined), hourly("linux", undefined)]);

    expect(view.lastHourReported).toBe(false);
    expect(view.lastHour).toEqual(EMPTY_USAGE_TOTALS);
    expect(view.lastHourActiveAccounts).toBe(0);
  });

  it("counts only accounts that ran a turn inside the window as active", () => {
    const view = buildAccountsUsageView([
      hourly("mac", totals({ turns: 3, costUsd: 1 }), 3),
      hourly("idle-box", totals(), 0),
    ]);

    expect(view.lastHourMachines).toBe(2);
    expect(view.lastHourActiveAccounts).toBe(1);
  });
});

describe("buildCliHistoryView", () => {
  it("treats an old server's missing key and an explicit null the same way", () => {
    for (const history of [undefined, null]) {
      const view = buildCliHistoryView(history);
      expect(view.reported).toBe(false);
      expect(view.status).toBeNull();
      expect(view.pending).toBe(false);
      expect(view.scanning).toBe(false);
      expect(view.hasUsage).toBe(false);
      expect(view.windows.allTime).toEqual(EMPTY_CLI_USAGE_TOTALS);
    }
  });

  it("marks a first pass as pending so nothing renders it as zero spend", () => {
    const view = buildCliHistoryView(
      cliHistory({ status: "scanning", computedAt: null, filesScanned: 0 }),
    );
    expect(view.reported).toBe(true);
    expect(view.scanning).toBe(true);
    expect(view.pending).toBe(true);
    expect(view.hasUsage).toBe(false);
  });

  it("keeps the last completed pass on screen while a rescan runs", () => {
    const view = buildCliHistoryView(
      cliHistory({
        status: "scanning",
        computedAt: "2026-07-25T17:00:00.000Z",
        providers: [flatProvider("claude", { costUsd: 12, messages: 30 })],
      }),
    );
    expect(view.scanning).toBe(true);
    expect(view.pending).toBe(false);
    expect(view.windows.allTime.costUsd).toBe(12);
  });

  it("reports a failed read rather than an empty one", () => {
    const view = buildCliHistoryView(cliHistory({ status: "failed", computedAt: null }));
    expect(view.failed).toBe(true);
    expect(view.pending).toBe(false);
    expect(view.hasUsage).toBe(false);
  });

  it("sums every window from the providers it is going to show", () => {
    const view = buildCliHistoryView(
      cliHistory({
        filesScanned: 5_536,
        providers: [
          cliProvider({
            provider: "claude",
            allTime: cliTotals({ costUsd: 19_389.62, messages: 68_295 }),
            last30Days: cliTotals({ costUsd: 15_000, messages: 50_000 }),
            last7Days: cliTotals({ costUsd: 4_000, messages: 12_000 }),
            today: cliTotals({ costUsd: 500, messages: 1_500 }),
          }),
          cliProvider({
            provider: "codex",
            allTime: cliTotals({ costUsd: 158_197.9, messages: 1_352_296 }),
            last30Days: cliTotals({ costUsd: 40_000, messages: 300_000 }),
            last7Days: cliTotals({ costUsd: 9_000, messages: 70_000 }),
            today: cliTotals({ costUsd: 1_200, messages: 9_000 }),
          }),
        ],
      }),
    );

    expect(view.windows.allTime.costUsd).toBeCloseTo(177_587.52, 2);
    expect(view.windows.allTime.messages).toBe(1_420_591);
    expect(view.windows.last30Days.costUsd).toBe(55_000);
    expect(view.windows.today.messages).toBe(10_500);
    expect(view.filesScanned).toBe(5_536);
    expect(view.hasUsage).toBe(true);
  });
});

describe("fleet CLI history", () => {
  const environment = (
    id: string,
    history: CliHistoricalUsage | null | undefined,
  ): Parameters<typeof buildAccountsUsageView>[0][number] => ({
    environmentId: environmentId(id),
    label: id,
    config: config([]),
    // `cliHistory` is an optional key: omitting it is what an old server does.
    usage: history === undefined ? usage() : usage({ cliHistory: history }),
  });

  it("stays silent when no machine's server knows about CLI history", () => {
    const view = buildAccountsUsageView([environment("mac", undefined), environment("box", null)]);
    expect(view.cliHistory.reported).toBe(false);
    expect(view.cliHistory.machines).toBe(0);
    expect(view.groups.every((group) => !group.cliHistory.reported)).toBe(true);
  });

  it("rolls two machines into one per-provider total, costliest provider first", () => {
    const view = buildAccountsUsageView([
      environment(
        "mac",
        cliHistory({
          filesScanned: 100,
          providers: [
            flatProvider("claude", { costUsd: 10, messages: 4 }),
            flatProvider("codex", { costUsd: 90, messages: 40 }),
          ],
        }),
      ),
      environment(
        "box",
        cliHistory({
          filesScanned: 50,
          providers: [flatProvider("claude", { costUsd: 5, messages: 2 })],
        }),
      ),
    ]);

    expect(view.cliHistory.reported).toBe(true);
    expect(view.cliHistory.machines).toBe(2);
    expect(view.cliHistory.filesScanned).toBe(150);
    expect(view.cliHistory.windows.allTime.costUsd).toBe(105);
    expect(view.cliHistory.providers.map((entry) => entry.provider)).toEqual(["codex", "claude"]);
    expect(view.cliHistory.providers[0]?.machines).toBe(1);
    expect(view.cliHistory.providers[1]?.machines).toBe(2);
    expect(view.cliHistory.providers[1]?.windows.allTime.costUsd).toBe(15);
  });

  it("is scanning while any machine is, and pending only while all of them are", () => {
    const scanningOnly = buildAccountsUsageView([
      environment("mac", cliHistory({ status: "scanning", computedAt: null })),
      environment("box", cliHistory({ status: "scanning", computedAt: null })),
    ]);
    expect(scanningOnly.cliHistory.scanning).toBe(true);
    expect(scanningOnly.cliHistory.pending).toBe(true);

    const mixed = buildAccountsUsageView([
      environment("mac", cliHistory({ status: "scanning", computedAt: null })),
      environment(
        "box",
        cliHistory({ providers: [flatProvider("codex", { costUsd: 3, messages: 1 })] }),
      ),
    ]);
    expect(mixed.cliHistory.scanning).toBe(true);
    expect(mixed.cliHistory.pending).toBe(false);
    expect(mixed.cliHistory.windows.allTime.costUsd).toBe(3);
  });

  it("flags a failed machine without dropping the machines that answered", () => {
    const view = buildAccountsUsageView([
      environment("mac", cliHistory({ status: "failed", computedAt: null })),
      environment(
        "box",
        cliHistory({ providers: [flatProvider("claude", { costUsd: 7, messages: 2 })] }),
      ),
    ]);
    expect(view.cliHistory.failed).toBe(true);
    expect(view.cliHistory.windows.allTime.costUsd).toBe(7);
  });

  it("carries unpriced messages up to the fleet, marking the cost a floor", () => {
    const view = buildAccountsUsageView([
      environment(
        "mac",
        cliHistory({
          providers: [
            flatProvider("codex", {
              costUsd: 158_197.9,
              messages: 1_352_296,
              unpricedMessages: 584_734,
            }),
            flatProvider("claude", { costUsd: 19_389.62, messages: 68_295 }),
          ],
        }),
      ),
    ]);

    expect(view.cliHistory.costIsFloor).toBe(true);
    expect(view.cliHistory.windows.allTime.unpricedMessages).toBe(584_734);
    expect(unpricedShare(view.cliHistory.windows.allTime)).toBeCloseTo(0.412, 3);
  });

  it("does not call a fully priced history a floor", () => {
    const view = buildAccountsUsageView([
      environment(
        "mac",
        cliHistory({ providers: [flatProvider("claude", { costUsd: 4, messages: 9 })] }),
      ),
    ]);
    expect(view.cliHistory.costIsFloor).toBe(false);
    expect(unpricedShare(cliTotals())).toBeNull();
  });

  it("leaves the fork-recorded totals untouched by CLI history", () => {
    const view = buildAccountsUsageView([
      environment(
        "mac",
        cliHistory({ providers: [flatProvider("claude", { costUsd: 19_389.62, messages: 5 })] }),
      ),
    ]);
    expect(view.today).toEqual(EMPTY_USAGE_TOTALS);
    expect(view.week).toEqual(EMPTY_USAGE_TOTALS);
  });
});

describe("foldCliModelRows", () => {
  it("scales bars against the costliest model", () => {
    const { rows, shareBasis } = foldCliModelRows([
      model("claude-fable-5", 11_413.28),
      model("claude-opus-4-8", 4_841.81),
    ]);
    expect(shareBasis).toBe("cost");
    expect(rows[0]?.share).toBe(1);
    expect(rows[1]?.share).toBeCloseTo(0.424, 3);
  });

  it("folds the tail into one row so the rows still add up to the total", () => {
    const models = Array.from({ length: 11 }, (_, index) => model(`model-${index}`, 11 - index));
    const { rows } = foldCliModelRows(models, 8);

    expect(rows).toHaveLength(9);
    const tail = rows[8];
    expect(tail?.model).toBe("3 more models");
    expect(tail?.modelCount).toBe(3);
    expect(tail?.totals.costUsd).toBe(3 + 2 + 1);
    expect(rows.reduce((total, row) => total + row.totals.costUsd, 0)).toBe(66);
  });

  it("ranks by messages when nothing in the list has a price", () => {
    const { rows, shareBasis } = foldCliModelRows([
      model("gpt-5.6-sol", 0, { messages: 400_000 }, false),
      model("unknown", 0, { messages: 100_000 }, false),
    ]);
    expect(shareBasis).toBe("messages");
    expect(rows[0]?.priced).toBe(false);
    expect(rows[0]?.share).toBe(1);
    expect(rows[1]?.share).toBeCloseTo(0.25, 5);
  });

  it("has nothing to draw for a provider with no models", () => {
    expect(foldCliModelRows([]).rows).toEqual([]);
  });
});

describe("peakUsedPercent", () => {
  const window = (usedPercent: number | null) => ({
    key: "primary",
    label: "Primary",
    usedPercent,
    resetsAt: null,
    windowMinutes: null,
  });

  it("distinguishes no data from zero usage", () => {
    expect(peakUsedPercent(null)).toBeNull();
    expect(
      peakUsedPercent({
        status: "allowed",
        planLabel: null,
        windows: [],
        observedAt: "2026-07-24T17:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      peakUsedPercent({
        status: "allowed",
        planLabel: null,
        windows: [window(0)],
        observedAt: "2026-07-24T17:00:00.000Z",
      }),
    ).toBe(0);
  });

  it("ignores windows the provider did not report a figure for", () => {
    expect(
      peakUsedPercent({
        status: "allowed",
        planLabel: null,
        windows: [window(null)],
        observedAt: "2026-07-24T17:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      peakUsedPercent({
        status: "allowed",
        planLabel: null,
        windows: [window(null), window(63)],
        observedAt: "2026-07-24T17:00:00.000Z",
      }),
    ).toBe(63);
  });

  it("takes the worst window", () => {
    expect(
      peakUsedPercent({
        status: "allowed",
        planLabel: null,
        windows: [window(12), window(88), window(40)],
        observedAt: "2026-07-24T17:00:00.000Z",
      }),
    ).toBe(88);
  });
});

describe("formatting", () => {
  it("formats money without pretending sub-cent spend is nothing", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(1234.5)).toBe("$1,235");
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(48_000)).toBe("48k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
    expect(formatTokens(31_000_000)).toBe("31M");
  });

  it("spells message counts out in full", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(584_734)).toBe("584,734");
    expect(formatCount(1_352_296)).toBe("1,352,296");
  });

  it("describes the span a CLI's history covers", () => {
    expect(formatDayRange("2026-06-10", "2026-07-25")).toBe("Jun 10 – Jul 25, 2026");
    expect(formatDayRange("2025-09-15", "2026-07-25")).toBe("Sep 15, 2025 – Jul 25, 2026");
    expect(formatDayRange("2026-07-25", "2026-07-25")).toBe("Jul 25, 2026");
    expect(formatDayRange(null, "2026-07-25")).toBeNull();
    expect(formatDayRange("2026-07-25", null)).toBeNull();
    expect(formatDayRange("yesterday", "2026-07-25")).toBeNull();
  });

  it("counts down to a reset and stays quiet once it has passed", () => {
    const now = Date.parse("2026-07-24T12:00:00.000Z");
    expect(formatResetCountdown("2026-07-24T12:45:00.000Z", now)).toBe("45m");
    expect(formatResetCountdown("2026-07-24T14:15:00.000Z", now)).toBe("2h 15m");
    expect(formatResetCountdown("2026-07-25T12:00:00.000Z", now)).toBe("1d");
    expect(formatResetCountdown("2026-07-24T11:00:00.000Z", now)).toBeNull();
    expect(formatResetCountdown(null, now)).toBeNull();
    expect(formatResetCountdown("not-a-date", now)).toBeNull();
  });
});
