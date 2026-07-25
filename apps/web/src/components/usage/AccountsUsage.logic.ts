/**
 * View model for the Accounts & Usage panel.
 *
 * Joins three sources that each know half the story:
 *  - the connection catalog, which knows every machine,
 *  - each machine's `ServerConfig.providers`, which knows the account behind
 *    every provider instance (email, plan, auth status),
 *  - each machine's usage snapshot, which knows what that account has spent
 *    and how much of its allowance is left.
 *
 * Pure so the join rules are testable without a browser.
 *
 * @module AccountsUsageLogic
 */
import {
  EMPTY_USAGE_TOTALS,
  type EnvironmentId,
  type EnvironmentUsageSnapshot,
  type ProviderInstanceUsage,
  type ServerConfig,
  type ServerProvider,
  type UsageTotals,
} from "@t3tools/contracts";

export interface AccountsUsageEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly config: ServerConfig | null;
  readonly usage: EnvironmentUsageSnapshot | null;
}

export interface AccountUsageRow {
  readonly instanceId: string;
  readonly displayName: string;
  readonly driver: string;
  readonly accentColor: string | null;
  readonly authStatus: ServerProvider["auth"]["status"] | "unknown";
  readonly email: string | null;
  /** Plan tier, preferring the provider probe's label over the rate-limit event's. */
  readonly planLabel: string | null;
  readonly enabled: boolean;
  readonly installed: boolean;
  /** True when a provider instance is configured but has no usage counterpart. */
  readonly orphanedUsage: boolean;
  readonly rateLimits: ProviderInstanceUsage["rateLimits"];
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  readonly lastTurnAt: string | null;
}

export interface AccountsUsageEnvironmentGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Null until the machine's first usage read lands, or if it never does. */
  readonly timeZone: string | null;
  readonly usageAvailable: boolean;
  readonly configAvailable: boolean;
  readonly accounts: ReadonlyArray<AccountUsageRow>;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
}

export interface AccountsUsageView {
  readonly groups: ReadonlyArray<AccountsUsageEnvironmentGroup>;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  readonly accountCount: number;
  /** Set when the machines disagree about which local day "today" is. */
  readonly mixedDays: boolean;
}

function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    turns: left.turns + right.turns,
    costUsd: left.costUsd + right.costUsd,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function sumTotals(values: Iterable<UsageTotals>): UsageTotals {
  let total = EMPTY_USAGE_TOTALS;
  for (const value of values) total = addTotals(total, value);
  return total;
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName ?? provider.instanceId;
}

function buildEnvironmentGroup(
  input: AccountsUsageEnvironmentInput,
): AccountsUsageEnvironmentGroup {
  const usageByInstance = new Map(
    (input.usage?.instances ?? []).map((instance) => [
      instance.providerInstanceId as string,
      instance,
    ]),
  );

  const accounts: Array<AccountUsageRow> = [];

  for (const provider of input.config?.providers ?? []) {
    const instanceId = provider.instanceId as string;
    const usage = usageByInstance.get(instanceId);
    usageByInstance.delete(instanceId);
    accounts.push({
      instanceId,
      displayName: providerDisplayName(provider),
      driver: provider.driver as string,
      accentColor: provider.accentColor ?? null,
      authStatus: provider.auth.status,
      email: provider.auth.email ?? null,
      planLabel: provider.auth.label ?? usage?.rateLimits?.planLabel ?? null,
      enabled: provider.enabled,
      installed: provider.installed,
      orphanedUsage: false,
      rateLimits: usage?.rateLimits ?? null,
      today: usage?.today ?? EMPTY_USAGE_TOTALS,
      week: usage?.week ?? EMPTY_USAGE_TOTALS,
      lastTurnAt: usage?.lastTurnAt ?? null,
    });
  }

  // Spend recorded against an instance that is no longer configured — a
  // deleted or renamed account. Shown rather than dropped: money that was
  // spent should never disappear from the total because a config entry went
  // away.
  for (const [instanceId, usage] of usageByInstance) {
    accounts.push({
      instanceId,
      displayName: instanceId,
      driver: usage.driver as string,
      accentColor: null,
      authStatus: "unknown",
      email: null,
      planLabel: usage.rateLimits?.planLabel ?? null,
      enabled: false,
      installed: false,
      orphanedUsage: true,
      rateLimits: usage.rateLimits,
      today: usage.today,
      week: usage.week,
      lastTurnAt: usage.lastTurnAt,
    });
  }

  accounts.sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) ||
      left.instanceId.localeCompare(right.instanceId),
  );

  return {
    environmentId: input.environmentId,
    label: input.label,
    timeZone: input.usage?.timeZone ?? null,
    usageAvailable: input.usage !== null,
    configAvailable: input.config !== null,
    accounts,
    today: sumTotals(accounts.map((account) => account.today)),
    week: sumTotals(accounts.map((account) => account.week)),
  };
}

export function buildAccountsUsageView(
  environments: ReadonlyArray<AccountsUsageEnvironmentInput>,
): AccountsUsageView {
  const groups = environments
    .map(buildEnvironmentGroup)
    .toSorted((left, right) => left.label.localeCompare(right.label));

  const days = new Set(
    environments.flatMap((environment) =>
      environment.usage === null ? [] : [environment.usage.today],
    ),
  );

  return {
    groups,
    today: sumTotals(groups.map((group) => group.today)),
    week: sumTotals(groups.map((group) => group.week)),
    accountCount: groups.reduce((count, group) => count + group.accounts.length, 0),
    mixedDays: days.size > 1,
  };
}

/**
 * Highest used percentage across an account's windows — the one number that
 * answers "am I about to be cut off". Null when the account has no rate-limit
 * data at all, which is different from 0%.
 */
export function peakUsedPercent(rateLimits: ProviderInstanceUsage["rateLimits"]): number | null {
  if (rateLimits === null) return null;
  const known = rateLimits.windows.flatMap((window) =>
    window.usedPercent === null ? [] : [window.usedPercent],
  );
  return known.length === 0 ? null : Math.max(...known);
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return value < 1000
    ? `$${value.toFixed(2)}`
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatTokens(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/**
 * "in 2h 15m" style countdown to a window reset. Returns null for a missing or
 * already-elapsed instant so the caller renders nothing rather than "in 0m".
 */
export function formatResetCountdown(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  const deltaMinutes = Math.round((resetMs - nowMs) / 60_000);
  if (deltaMinutes <= 0) return null;
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const hours = Math.floor(deltaMinutes / 60);
  const minutes = deltaMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}
