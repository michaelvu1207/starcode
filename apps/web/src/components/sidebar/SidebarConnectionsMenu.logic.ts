/**
 * What the connections dropdown says, separated from how it says it.
 *
 * The dropdown answers one question per machine — "can I use this right now,
 * and what is it costing me" — and every part of that answer is a fold over
 * data the app already has: the supervisor's connection state, the usage
 * snapshot the settings panel polls, and the fork's own ping sample. Keeping
 * the folds here is what makes them testable without a socket.
 *
 * The connection state read is deliberately the raw `SupervisorConnectionState`
 * rather than `EnvironmentConnectionPresentation`: the presentation layer drops
 * `attempt`, `retryAt`, and `stage`, and "reconnecting, retrying in 8s" is
 * precisely the sentence this dropdown exists to say.
 */
import type { EnvironmentUsageSnapshot } from "@starcode/contracts";
import type { SupervisorConnectionState } from "@starcode/client-runtime/connection";

import { peakUsedPercent } from "../usage/AccountsUsage.logic";

/** Ranked worst-first: the trigger badge and the row order both read this. */
export type ConnectionHealth = "connected" | "waiting" | "down";

export interface ConnectionMenuRowInput {
  readonly environmentId: string;
  readonly label: string;
  readonly isLocal: boolean;
  readonly isOwnBackend: boolean;
  readonly displayUrl: string | null;
  readonly state: SupervisorConnectionState | null;
  readonly usage: EnvironmentUsageSnapshot | null;
  readonly pingMs: number | null;
  readonly pingPending: boolean;
}

export interface ConnectionMenuRow {
  readonly environmentId: string;
  readonly label: string;
  readonly isLocal: boolean;
  readonly isOwnBackend: boolean;
  readonly displayUrl: string | null;
  readonly health: ConnectionHealth;
  /** One short line under the label: phase, plus what it is waiting on. */
  readonly statusLabel: string;
  /** "24 ms", or a word when there is no number to show. */
  readonly pingLabel: string;
  /** Whether `pingLabel` is a measurement rather than a placeholder. */
  readonly hasPing: boolean;
  readonly spendTodayUsd: number | null;
  /**
   * Today's spend from the machine's own CLI session stores. Deliberately a
   * second number rather than part of `spendTodayUsd`: that one counts turns
   * the fork ran, this counts messages the CLIs wrote to disk, and a turn the
   * fork ran through a CLI lands in both.
   */
  readonly cliSpendTodayUsd: number | null;
  /** Highest rate-limit window across the machine's accounts, 0-100 or null. */
  readonly peakRateLimitPercent: number | null;
  /** True when at least one account is at or past its warning threshold. */
  readonly rateLimitWarning: boolean;
  readonly retryAvailable: boolean;
  readonly error: string | null;
}

/**
 * The percentage at which a rate limit stops being background information.
 * Matches the point the usage panel starts colouring bars.
 */
export const RATE_LIMIT_WARNING_PERCENT = 80;

export function connectionHealthOf(state: SupervisorConnectionState | null): ConnectionHealth {
  switch (state?.phase) {
    case "connected":
      return "connected";
    case "connecting":
      return "waiting";
    case "backoff":
    case "blocked":
    case "offline":
      return "down";
    default:
      // `available` (never dialled) and an unknown machine are both "not up
      // yet", not "broken" — a machine you have not opened has failed nothing.
      return "waiting";
  }
}

/**
 * Seconds until the supervisor's next attempt, or null when it is not waiting
 * on a clock. Rounded up so a countdown never displays "in 0s".
 */
export function retryCountdownSeconds(
  state: SupervisorConnectionState | null,
  nowMs: number,
): number | null {
  if (state === null || state.retryAt === null) return null;
  const remaining = Math.ceil((state.retryAt - nowMs) / 1000);
  return remaining > 0 ? remaining : null;
}

const STAGE_LABELS: Record<NonNullable<SupervisorConnectionState["stage"]>, string> = {
  preparing: "Preparing",
  opening: "Opening",
  synchronizing: "Synchronizing",
};

export function connectionStatusLabel(
  state: SupervisorConnectionState | null,
  nowMs: number,
): string {
  if (state === null) return "Not connected";
  switch (state.phase) {
    case "connected":
      return "Connected";
    case "offline":
      return "Offline";
    case "blocked":
      return state.lastFailure?.message ?? "Blocked";
    case "connecting": {
      const stage = state.stage === null ? "Connecting" : STAGE_LABELS[state.stage];
      // Attempt 1 with nothing behind it is a first connect; anything else is
      // a retry, and saying which attempt is the difference between "slow" and
      // "stuck in a loop".
      return state.attempt > 1 ? `${stage} · attempt ${state.attempt}` : stage;
    }
    case "backoff": {
      const seconds = retryCountdownSeconds(state, nowMs);
      return seconds === null ? "Reconnecting" : `Reconnecting in ${seconds}s`;
    }
    case "available":
      return "Not connected";
  }
}

/**
 * A ping is only meaningful on a live connection. On anything else the row
 * shows a dash, which reads as "not applicable" rather than "fast".
 */
export function connectionPingLabel(input: {
  readonly state: SupervisorConnectionState | null;
  readonly pingMs: number | null;
  readonly pingPending: boolean;
}): { readonly label: string; readonly hasPing: boolean } {
  if (input.state?.phase !== "connected") return { label: "—", hasPing: false };
  if (input.pingMs !== null) return { label: `${Math.round(input.pingMs)} ms`, hasPing: true };
  return input.pingPending
    ? { label: "…", hasPing: false }
    : { label: "no answer", hasPing: false };
}

/**
 * Highest rate-limit pressure across every account on the machine. Null when
 * no account reported a figure at all — which is not the same as 0%, and the
 * row renders it as a striped track rather than an empty bar.
 */
export function machinePeakRateLimitPercent(usage: EnvironmentUsageSnapshot | null): number | null {
  if (usage === null) return null;
  const known = usage.instances.flatMap((instance) => {
    const peak = peakUsedPercent(instance.rateLimits);
    return peak === null ? [] : [peak];
  });
  return known.length === 0 ? null : Math.max(...known);
}

/** True when any account has been warned or rejected outright by its provider. */
export function machineRateLimitWarning(usage: EnvironmentUsageSnapshot | null): boolean {
  if (usage === null) return false;
  return usage.instances.some((instance) => {
    if (instance.rateLimits === null) return false;
    if (instance.rateLimits.status !== "allowed") return true;
    const peak = peakUsedPercent(instance.rateLimits);
    return peak !== null && peak >= RATE_LIMIT_WARNING_PERCENT;
  });
}

/**
 * Today's CLI-store spend on one machine, or null when there is no answer:
 * either the machine's server predates CLI history, or its first scan has not
 * finished. Null is rendered as nothing at all — a machine mid-scan has not
 * spent $0.00, we simply do not know yet.
 */
export function machineCliSpendTodayUsd(usage: EnvironmentUsageSnapshot | null): number | null {
  const history = usage?.cliHistory;
  if (history === null || history === undefined) return null;
  if (history.status === "scanning" && history.computedAt === null) return null;
  return history.providers.reduce((total, provider) => total + provider.today.costUsd, 0);
}

export function buildConnectionMenuRow(
  input: ConnectionMenuRowInput,
  nowMs: number,
): ConnectionMenuRow {
  const ping = connectionPingLabel(input);
  return {
    environmentId: input.environmentId,
    label: input.label,
    isLocal: input.isLocal,
    isOwnBackend: input.isOwnBackend,
    displayUrl: input.displayUrl,
    health: connectionHealthOf(input.state),
    statusLabel: connectionStatusLabel(input.state, nowMs),
    pingLabel: ping.label,
    hasPing: ping.hasPing,
    spendTodayUsd: input.usage === null ? null : input.usage.totalsToday.costUsd,
    cliSpendTodayUsd: machineCliSpendTodayUsd(input.usage),
    peakRateLimitPercent: machinePeakRateLimitPercent(input.usage),
    rateLimitWarning: machineRateLimitWarning(input.usage),
    // Retrying a machine that is already connected or mid-dial does nothing
    // useful; offering it there would just be a button that appears to do
    // nothing.
    retryAvailable:
      input.state !== null && (input.state.phase === "backoff" || input.state.phase === "blocked"),
    error: input.state?.lastFailure?.message ?? null,
  };
}

export interface ConnectionMenuSummary {
  readonly rows: ReadonlyArray<ConnectionMenuRow>;
  /** Sum of today's spend across every machine that reported a figure. */
  readonly fleetSpendTodayUsd: number;
  /** True when at least one machine reported anything at all. */
  readonly hasFleetSpend: boolean;
  /** Same day, same fleet, other provenance — the CLIs' own stores. */
  readonly fleetCliSpendTodayUsd: number;
  /** Drives the badge on the icon-strip trigger. */
  readonly needsAttention: boolean;
  readonly downCount: number;
}

/**
 * The whole dropdown in one fold. Rows keep the caller's order (local first,
 * then by label — the same order the sidebar groups use) so the dropdown and
 * the sidebar never disagree about which machine is which.
 */
export function buildConnectionMenuSummary(
  inputs: ReadonlyArray<ConnectionMenuRowInput>,
  nowMs: number,
): ConnectionMenuSummary {
  const rows = inputs.map((input) => buildConnectionMenuRow(input, nowMs));
  const spending = rows.flatMap((row) => (row.spendTodayUsd === null ? [] : [row.spendTodayUsd]));
  return {
    rows,
    fleetSpendTodayUsd: spending.reduce((total, value) => total + value, 0),
    fleetCliSpendTodayUsd: rows.reduce((total, row) => total + (row.cliSpendTodayUsd ?? 0), 0),
    hasFleetSpend: spending.length > 0,
    // A machine that has never been dialled is not an alarm. The badge fires
    // for machines that were meant to be up and are not, and for accounts
    // close enough to a limit that the next turn may be refused.
    needsAttention: rows.some((row) => row.health === "down" || row.rateLimitWarning),
    downCount: rows.filter((row) => row.health === "down").length,
  };
}
