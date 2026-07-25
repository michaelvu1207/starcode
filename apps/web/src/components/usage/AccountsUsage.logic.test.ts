import {
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
  formatResetCountdown,
  formatTokens,
  formatUsd,
  peakUsedPercent,
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
