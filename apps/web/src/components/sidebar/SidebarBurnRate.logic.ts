/**
 * The masthead burn rate — what the whole fleet is spending per hour.
 *
 * One number folded from every connected machine's trailing-hour window. The
 * window is sixty minutes wide precisely so this is not an extrapolation: the
 * figure shown *is* what was spent, and reads as a rate only because the window
 * happens to be an hour.
 *
 * Three states, and the difference between them matters more than the number:
 *  - `spend` — a dollar figure the providers actually reported;
 *  - `tokens` — turns ran but every one of them priced at nothing, which is
 *    what a subscription account looks like. Rendering "$0.00/hr" there would
 *    claim the hour was free rather than admit it was never priced;
 *  - `idle` — no turns at all, which is the only honest zero.
 *
 * Pure so those rules are testable without a sidebar around them.
 *
 * @module SidebarBurnRateLogic
 */
import { type UsageTotals, USAGE_RATE_WINDOW_MINUTES } from "@t3tools/contracts";

import { formatTokens, formatUsd } from "../usage/AccountsUsage.logic";

export interface BurnRateInput {
  /** False until at least one machine's server reports the window at all. */
  readonly reported: boolean;
  readonly totals: UsageTotals;
  /** Machines contributing to the figure. */
  readonly machines: number;
  /** Machines connected, reporting or not — the two differ in a mixed fleet. */
  readonly connectedMachines: number;
  /** Accounts that ran at least one turn inside the window. */
  readonly activeAccounts: number;
}

export type BurnRateState = "spend" | "tokens" | "idle";

export interface BurnRateView {
  /** False when there is nothing truthful to show; the caller renders nothing. */
  readonly visible: boolean;
  readonly state: BurnRateState;
  /** The headline, e.g. `$4.20/hr`. */
  readonly primary: string;
  /** The supporting figure, e.g. `1.2M tok/hr`; null when there is none. */
  readonly secondary: string | null;
  readonly tooltip: string;
  readonly ariaLabel: string;
}

const HIDDEN: BurnRateView = {
  visible: false,
  state: "idle",
  primary: "",
  secondary: null,
  tooltip: "",
  ariaLabel: "",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * "across 3 accounts on 2 machines", and — when the fleet disagrees about
 * whether it can answer at all — how many machines are being left out. A rate
 * that silently covers half the fleet is worse than one that says so.
 */
function coverage(input: BurnRateInput): string {
  const machines =
    input.connectedMachines > input.machines
      ? `${input.machines} of ${plural(input.connectedMachines, "machine")}`
      : plural(input.machines, "machine");
  return `${plural(input.activeAccounts, "account")} on ${machines}`;
}

export function buildBurnRateView(input: BurnRateInput): BurnRateView {
  if (!input.reported) return HIDDEN;

  const window = `the last ${USAGE_RATE_WINDOW_MINUTES} minutes`;
  const tokens = input.totals.inputTokens + input.totals.outputTokens;
  const tokenLabel = `${formatTokens(tokens)} tok/hr`;

  if (input.totals.turns === 0) {
    return {
      visible: true,
      state: "idle",
      primary: "Idle",
      secondary: "past hour",
      tooltip: `No turns in ${window} across ${plural(input.machines, "machine")}.`,
      ariaLabel: `No usage in ${window}`,
    };
  }

  if (input.totals.costUsd === 0) {
    return {
      visible: true,
      state: "tokens",
      primary: tokenLabel,
      secondary: null,
      tooltip:
        `${formatTokens(tokens)} tokens over ${plural(input.totals.turns, "turn")} in ${window}, ` +
        `${coverage(input)}. No dollar figure: every account that ran reported tokens without a cost, ` +
        `which is what a subscription plan looks like.`,
      ariaLabel: `${tokenLabel} in ${window}`,
    };
  }

  const costLabel = `${formatUsd(input.totals.costUsd)}/hr`;
  return {
    visible: true,
    state: "spend",
    primary: costLabel,
    secondary: tokenLabel,
    tooltip:
      `${formatUsd(input.totals.costUsd)} and ${formatTokens(tokens)} tokens over ` +
      `${plural(input.totals.turns, "turn")} in ${window}, ${coverage(input)}. ` +
      `Only turns run through starcode are counted, and only providers that report a cost contribute to it.`,
    ariaLabel: `${costLabel}, ${tokenLabel} in ${window}`,
  };
}
