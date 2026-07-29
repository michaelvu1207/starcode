import { EMPTY_USAGE_TOTALS, type UsageTotals } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type BurnRateInput, buildBurnRateView } from "./SidebarBurnRate.logic";

const totals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  ...EMPTY_USAGE_TOTALS,
  ...overrides,
});

const input = (overrides: Partial<BurnRateInput> = {}): BurnRateInput => ({
  reported: true,
  totals: totals(),
  machines: 1,
  connectedMachines: 1,
  activeAccounts: 0,
  ...overrides,
});

describe("buildBurnRateView", () => {
  it("hides itself when no machine reports the window", () => {
    expect(buildBurnRateView(input({ reported: false })).visible).toBe(false);
  });

  it("shows spend and tokens when the providers priced the hour", () => {
    const view = buildBurnRateView(
      input({
        totals: totals({ turns: 6, costUsd: 4.2, inputTokens: 900_000, outputTokens: 300_000 }),
        machines: 2,
        connectedMachines: 2,
        activeAccounts: 3,
      }),
    );

    expect(view.state).toBe("spend");
    expect(view.primary).toBe("$4.20/hr");
    expect(view.secondary).toBe("1.2M tok/hr");
    expect(view.tooltip).toContain("3 accounts on 2 machines");
    expect(view.tooltip).toContain("6 turns");
  });

  it("drops the dollar figure rather than claiming a subscription hour was free", () => {
    const view = buildBurnRateView(
      input({
        totals: totals({ turns: 4, costUsd: 0, inputTokens: 40_000, outputTokens: 10_000 }),
        activeAccounts: 1,
      }),
    );

    expect(view.state).toBe("tokens");
    expect(view.primary).toBe("50k tok/hr");
    expect(view.secondary).toBeNull();
    expect(view.primary).not.toContain("$");
    expect(view.tooltip).toContain("subscription");
  });

  it("reads no turns as idle, which is the only honest zero", () => {
    const view = buildBurnRateView(input({ machines: 3, connectedMachines: 3 }));

    expect(view.state).toBe("idle");
    expect(view.primary).toBe("Idle");
    expect(view.tooltip).toContain("3 machines");
  });

  it("says so when the rate covers only part of the fleet", () => {
    const view = buildBurnRateView(
      input({
        totals: totals({ turns: 1, costUsd: 0.5 }),
        machines: 1,
        connectedMachines: 3,
        activeAccounts: 1,
      }),
    );

    expect(view.tooltip).toContain("1 of 3 machines");
    expect(view.tooltip).toContain("1 account on");
  });

  it("keeps sub-cent spend from rounding away to nothing", () => {
    const view = buildBurnRateView(
      input({ totals: totals({ turns: 1, costUsd: 0.004, outputTokens: 120 }), activeAccounts: 1 }),
    );

    expect(view.state).toBe("spend");
    expect(view.primary).toBe("<$0.01/hr");
  });
});
