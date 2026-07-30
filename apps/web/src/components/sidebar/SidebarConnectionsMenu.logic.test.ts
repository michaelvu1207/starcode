import type { SupervisorConnectionState } from "@starcode/client-runtime/connection";
import {
  type CliHistoricalUsage,
  type CliUsageTotals,
  EMPTY_CLI_USAGE_TOTALS,
  type EnvironmentUsageSnapshot,
  type UsageTotals,
} from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildConnectionMenuRow,
  buildConnectionMenuSummary,
  connectionHealthOf,
  connectionPingLabel,
  connectionStatusLabel,
  machinePeakRateLimitPercent,
  machineRateLimitWarning,
  retryCountdownSeconds,
  type ConnectionMenuRowInput,
} from "./SidebarConnectionsMenu.logic";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

function state(overrides: Partial<SupervisorConnectionState> = {}): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connected",
    stage: null,
    attempt: 1,
    generation: 1,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

function totals(costUsd: number): UsageTotals {
  return {
    turns: 1,
    costUsd,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0,
  };
}

function usage(
  instances: EnvironmentUsageSnapshot["instances"],
  todayCostUsd = 0,
): EnvironmentUsageSnapshot {
  return {
    generatedAt: "2026-07-25T12:00:00.000Z",
    timeZone: "UTC",
    today: "2026-07-25",
    instances,
    totalsToday: totals(todayCostUsd),
    totalsWeek: totals(todayCostUsd),
  };
}

/** A finished scan whose whole day's spend sits on one CLI. */
function cliHistory(todayCostUsd: number): CliHistoricalUsage {
  const totals: CliUsageTotals = {
    ...EMPTY_CLI_USAGE_TOTALS,
    costUsd: todayCostUsd,
    messages: 1,
  };
  return {
    status: "ready",
    computedAt: "2026-07-25T11:00:00.000Z",
    providers: [
      {
        provider: "codex",
        allTime: totals,
        last30Days: totals,
        last7Days: totals,
        today: totals,
        models: [],
        firstDay: "2026-07-25",
        lastDay: "2026-07-25",
        sessionFiles: 1,
      },
    ],
    totals,
    filesScanned: 1,
  };
}

/** `cliHistory` is an optional key, so it is attached rather than defaulted. */
function withCliHistory(
  snapshot: EnvironmentUsageSnapshot,
  history: CliHistoricalUsage | null,
): EnvironmentUsageSnapshot {
  return { ...snapshot, cliHistory: history };
}

type InstanceUsage = EnvironmentUsageSnapshot["instances"][number];

/** Both ids are branded; the fixtures only ever need them to be distinct. */
const instanceId = (value: string): InstanceUsage["providerInstanceId"] =>
  value as InstanceUsage["providerInstanceId"];

function instance(overrides: Partial<InstanceUsage> = {}): InstanceUsage {
  return {
    providerInstanceId: instanceId("instance-1"),
    driver: "claude" as InstanceUsage["driver"],
    rateLimits: null,
    today: totals(0),
    week: totals(0),
    days: [],
    lastTurnAt: null,
    ...overrides,
  };
}

function rowInput(overrides: Partial<ConnectionMenuRowInput> = {}): ConnectionMenuRowInput {
  return {
    environmentId: "env-1",
    label: "Mac",
    isLocal: false,
    isOwnBackend: false,
    displayUrl: null,
    state: state(),
    usage: null,
    pingMs: null,
    pingPending: false,
    ...overrides,
  };
}

describe("connectionHealthOf", () => {
  it("treats a machine that was never dialled as waiting, not broken", () => {
    // `available` means "registered, not connected yet". Badging that as down
    // would light the icon-strip badge permanently on a fresh client.
    expect(connectionHealthOf(state({ phase: "available" }))).toBe("waiting");
    expect(connectionHealthOf(null)).toBe("waiting");
  });

  it("separates connected, in-flight, and failed", () => {
    expect(connectionHealthOf(state({ phase: "connected" }))).toBe("connected");
    expect(connectionHealthOf(state({ phase: "connecting" }))).toBe("waiting");
    expect(connectionHealthOf(state({ phase: "backoff" }))).toBe("down");
    expect(connectionHealthOf(state({ phase: "blocked" }))).toBe("down");
    expect(connectionHealthOf(state({ phase: "offline" }))).toBe("down");
  });
});

describe("retryCountdownSeconds", () => {
  it("rounds up so a countdown never shows zero", () => {
    expect(retryCountdownSeconds(state({ retryAt: NOW + 1200 }), NOW)).toBe(2);
  });

  it("returns null once the retry instant has passed", () => {
    expect(retryCountdownSeconds(state({ retryAt: NOW - 5_000 }), NOW)).toBeNull();
  });

  it("returns null when nothing is scheduled", () => {
    expect(retryCountdownSeconds(state({ retryAt: null }), NOW)).toBeNull();
    expect(retryCountdownSeconds(null, NOW)).toBeNull();
  });
});

describe("connectionStatusLabel", () => {
  it("counts down to the next attempt while backing off", () => {
    // This is the whole reason the dropdown reads the raw supervisor state:
    // the presentation projection drops `retryAt`, so it cannot say this.
    expect(connectionStatusLabel(state({ phase: "backoff", retryAt: NOW + 8_000 }), NOW)).toBe(
      "Reconnecting in 8s",
    );
  });

  it("falls back to a bare phase when backoff has no scheduled instant", () => {
    expect(connectionStatusLabel(state({ phase: "backoff", retryAt: null }), NOW)).toBe(
      "Reconnecting",
    );
  });

  it("names the stage of a first connection and the attempt of a retry", () => {
    expect(connectionStatusLabel(state({ phase: "connecting", stage: "opening" }), NOW)).toBe(
      "Opening",
    );
    expect(
      connectionStatusLabel(
        state({ phase: "connecting", stage: "synchronizing", attempt: 3 }),
        NOW,
      ),
    ).toBe("Synchronizing · attempt 3");
  });

  it("surfaces the failure message when a connection is blocked", () => {
    expect(
      connectionStatusLabel(
        state({
          phase: "blocked",
          lastFailure: {
            message: "Credentials rejected",
          } as SupervisorConnectionState["lastFailure"],
        }),
        NOW,
      ),
    ).toBe("Credentials rejected");
  });

  it("reads an unknown machine as not connected", () => {
    expect(connectionStatusLabel(null, NOW)).toBe("Not connected");
  });
});

describe("connectionPingLabel", () => {
  it("shows a rounded millisecond figure on a live connection", () => {
    expect(connectionPingLabel({ state: state(), pingMs: 23.6, pingPending: false })).toEqual({
      label: "24 ms",
      hasPing: true,
    });
  });

  it("shows a dash, not a number, when there is no live connection to measure", () => {
    // A machine in backoff has no session. Rendering "0 ms" there would read
    // as instant rather than absent.
    expect(
      connectionPingLabel({ state: state({ phase: "backoff" }), pingMs: 12, pingPending: false }),
    ).toEqual({ label: "—", hasPing: false });
  });

  it("distinguishes a measurement in flight from one that came back empty", () => {
    expect(connectionPingLabel({ state: state(), pingMs: null, pingPending: true })).toEqual({
      label: "…",
      hasPing: false,
    });
    expect(connectionPingLabel({ state: state(), pingMs: null, pingPending: false })).toEqual({
      label: "no answer",
      hasPing: false,
    });
  });
});

describe("machinePeakRateLimitPercent", () => {
  it("takes the worst window across every account on the machine", () => {
    expect(
      machinePeakRateLimitPercent(
        usage([
          instance({
            rateLimits: {
              status: "allowed",
              planLabel: null,
              windows: [
                {
                  key: "five_hour",
                  label: "5h",
                  usedPercent: 42,
                  resetsAt: null,
                  windowMinutes: null,
                },
              ],
              observedAt: "2026-07-25T11:00:00.000Z",
            },
          }),
          instance({
            providerInstanceId: instanceId("instance-2"),
            rateLimits: {
              status: "allowed",
              planLabel: null,
              windows: [
                {
                  key: "seven_day",
                  label: "7d",
                  usedPercent: 77,
                  resetsAt: null,
                  windowMinutes: null,
                },
              ],
              observedAt: "2026-07-25T11:00:00.000Z",
            },
          }),
        ]),
      ),
    ).toBe(77);
  });

  it("keeps unknown distinct from zero", () => {
    // Null renders as a striped track; zero would claim full headroom the
    // provider never reported.
    expect(machinePeakRateLimitPercent(usage([instance()]))).toBeNull();
    expect(machinePeakRateLimitPercent(null)).toBeNull();
  });
});

describe("machineRateLimitWarning", () => {
  it("warns on a provider that has already warned or refused", () => {
    expect(
      machineRateLimitWarning(
        usage([
          instance({
            rateLimits: {
              status: "rejected",
              planLabel: null,
              windows: [],
              observedAt: "2026-07-25T11:00:00.000Z",
            },
          }),
        ]),
      ),
    ).toBe(true);
  });

  it("warns once a window crosses the threshold even while still allowed", () => {
    expect(
      machineRateLimitWarning(
        usage([
          instance({
            rateLimits: {
              status: "allowed",
              planLabel: null,
              windows: [
                {
                  key: "five_hour",
                  label: "5h",
                  usedPercent: 81,
                  resetsAt: null,
                  windowMinutes: null,
                },
              ],
              observedAt: "2026-07-25T11:00:00.000Z",
            },
          }),
        ]),
      ),
    ).toBe(true);
  });

  it("stays quiet below the threshold and with no data at all", () => {
    expect(
      machineRateLimitWarning(
        usage([
          instance({
            rateLimits: {
              status: "allowed",
              planLabel: null,
              windows: [
                {
                  key: "five_hour",
                  label: "5h",
                  usedPercent: 40,
                  resetsAt: null,
                  windowMinutes: null,
                },
              ],
              observedAt: "2026-07-25T11:00:00.000Z",
            },
          }),
        ]),
      ),
    ).toBe(false);
    expect(machineRateLimitWarning(null)).toBe(false);
  });
});

describe("buildConnectionMenuRow", () => {
  it("offers retry only where retrying does something", () => {
    expect(buildConnectionMenuRow(rowInput({ state: state() }), NOW).retryAvailable).toBe(false);
    expect(
      buildConnectionMenuRow(rowInput({ state: state({ phase: "connecting" }) }), NOW)
        .retryAvailable,
    ).toBe(false);
    expect(
      buildConnectionMenuRow(rowInput({ state: state({ phase: "backoff" }) }), NOW).retryAvailable,
    ).toBe(true);
    expect(
      buildConnectionMenuRow(rowInput({ state: state({ phase: "blocked" }) }), NOW).retryAvailable,
    ).toBe(true);
  });

  it("leaves spend null rather than zero when no snapshot has landed", () => {
    expect(buildConnectionMenuRow(rowInput({ usage: null }), NOW).spendTodayUsd).toBeNull();
    expect(
      buildConnectionMenuRow(rowInput({ usage: usage([instance()], 4.2) }), NOW).spendTodayUsd,
    ).toBe(4.2);
  });

  it("reports CLI-store spend beside fork-recorded spend, never merged into it", () => {
    const row = buildConnectionMenuRow(
      rowInput({ usage: withCliHistory(usage([instance()], 0), cliHistory(12.5)) }),
      NOW,
    );
    expect(row.spendTodayUsd).toBe(0);
    expect(row.cliSpendTodayUsd).toBe(12.5);
  });

  it("has no CLI figure for an old server, or for a scan that has never finished", () => {
    expect(buildConnectionMenuRow(rowInput({ usage: usage([]) }), NOW).cliSpendTodayUsd).toBeNull();
    expect(
      buildConnectionMenuRow(rowInput({ usage: withCliHistory(usage([]), null) }), NOW)
        .cliSpendTodayUsd,
    ).toBeNull();
    expect(
      buildConnectionMenuRow(
        rowInput({
          usage: withCliHistory(usage([]), {
            ...cliHistory(0),
            status: "scanning",
            computedAt: null,
          }),
        }),
        NOW,
      ).cliSpendTodayUsd,
    ).toBeNull();
  });
});

describe("buildConnectionMenuSummary", () => {
  it("totals spend only across machines that reported it", () => {
    const summary = buildConnectionMenuSummary(
      [
        rowInput({ environmentId: "a", usage: usage([instance()], 4.2) }),
        rowInput({ environmentId: "b", usage: usage([instance()], 1.3) }),
        rowInput({ environmentId: "c", usage: null }),
      ],
      NOW,
    );
    expect(summary.fleetSpendTodayUsd).toBeCloseTo(5.5);
    expect(summary.hasFleetSpend).toBe(true);
  });

  it("reports no fleet spend at all when nothing has landed", () => {
    const summary = buildConnectionMenuSummary([rowInput({ usage: null })], NOW);
    expect(summary.hasFleetSpend).toBe(false);
    expect(summary.fleetSpendTodayUsd).toBe(0);
  });

  it("badges when a machine is down", () => {
    const summary = buildConnectionMenuSummary(
      [
        rowInput({ environmentId: "a" }),
        rowInput({ environmentId: "b", state: state({ phase: "backoff" }) }),
      ],
      NOW,
    );
    expect(summary.needsAttention).toBe(true);
    expect(summary.downCount).toBe(1);
  });

  it("badges on a rate limit even when every machine is up", () => {
    const summary = buildConnectionMenuSummary(
      [
        rowInput({
          usage: usage([
            instance({
              rateLimits: {
                status: "warning",
                planLabel: null,
                windows: [],
                observedAt: "2026-07-25T11:00:00.000Z",
              },
            }),
          ]),
        }),
      ],
      NOW,
    );
    expect(summary.downCount).toBe(0);
    expect(summary.needsAttention).toBe(true);
  });

  it("stays quiet for a healthy fleet and for a fleet nobody has dialled", () => {
    expect(buildConnectionMenuSummary([rowInput()], NOW).needsAttention).toBe(false);
    expect(
      buildConnectionMenuSummary([rowInput({ state: state({ phase: "available" }) })], NOW)
        .needsAttention,
    ).toBe(false);
  });

  it("keeps the order it was given", () => {
    const summary = buildConnectionMenuSummary(
      [rowInput({ environmentId: "b" }), rowInput({ environmentId: "a" })],
      NOW,
    );
    expect(summary.rows.map((row) => row.environmentId)).toEqual(["b", "a"]);
  });
});
