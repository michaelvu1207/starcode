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
 * A fourth, separate fold covers `cliHistory`: what each machine's Claude Code
 * and Codex CLIs spent in their own on-disk stores, before or outside the fork.
 * It is kept as its own view model rather than merged into the totals above
 * because the two provenances overlap — every turn the fork ran through a CLI
 * is counted by both — so summing them would double-count.
 *
 * Pure so the join rules are testable without a browser.
 *
 * @module AccountsUsageLogic
 */
import {
  type CliHistoricalUsage,
  type CliProviderUsage,
  type CliUsageModelTotals,
  type CliUsageProvider,
  type CliUsageScanStatus,
  type CliUsageTotals,
  EMPTY_CLI_USAGE_TOTALS,
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

/**
 * The four cumulative windows the historical section shows, in one value.
 *
 * Cumulative, not exclusive: a message from today is counted in `today`, in
 * `last7Days`, in `last30Days` and in `allTime`. Adding two windows together
 * therefore double-counts, and nothing here does it.
 */
export interface CliUsageWindows {
  readonly today: CliUsageTotals;
  readonly last7Days: CliUsageTotals;
  readonly last30Days: CliUsageTotals;
  readonly allTime: CliUsageTotals;
}

export const EMPTY_CLI_USAGE_WINDOWS: CliUsageWindows = {
  today: EMPTY_CLI_USAGE_TOTALS,
  last7Days: EMPTY_CLI_USAGE_TOTALS,
  last30Days: EMPTY_CLI_USAGE_TOTALS,
  allTime: EMPTY_CLI_USAGE_TOTALS,
};

/**
 * One machine's CLI history, made safe to render.
 *
 * `reported` is the old-server guard: a server that predates this feature omits
 * the key entirely, and a server that has it but has nothing to say sends null.
 * Both mean "this machine contributes nothing", and neither means zero spend.
 */
export interface CliHistoryMachineView {
  readonly reported: boolean;
  readonly status: CliUsageScanStatus | null;
  readonly computedAt: string | null;
  readonly scanning: boolean;
  readonly failed: boolean;
  /**
   * A scan is running and no pass has ever finished, so there are no numbers
   * yet. Callers must render this as "computing", never as $0.00 — the store
   * takes tens of seconds to walk and the endpoint answers before it is done.
   */
  readonly pending: boolean;
  readonly providers: ReadonlyArray<CliProviderUsage>;
  readonly windows: CliUsageWindows;
  readonly filesScanned: number;
  /** True once a finished pass found at least one priced or unpriced message. */
  readonly hasUsage: boolean;
}

export const EMPTY_CLI_HISTORY_MACHINE_VIEW: CliHistoryMachineView = {
  reported: false,
  status: null,
  computedAt: null,
  scanning: false,
  failed: false,
  pending: false,
  providers: [],
  windows: EMPTY_CLI_USAGE_WINDOWS,
  filesScanned: 0,
  hasUsage: false,
};

export interface CliHistoryProviderRollup {
  readonly provider: CliUsageProvider;
  readonly windows: CliUsageWindows;
  /** How many machines contributed to this provider's figures. */
  readonly machines: number;
}

export interface CliHistoryFleetView {
  /** True when at least one machine's server knows about CLI history at all. */
  readonly reported: boolean;
  readonly windows: CliUsageWindows;
  /** Costliest provider first, matching how models are ordered inside one. */
  readonly providers: ReadonlyArray<CliHistoryProviderRollup>;
  readonly scanning: boolean;
  readonly failed: boolean;
  /** Every reporting machine is still on its first pass; nothing to show yet. */
  readonly pending: boolean;
  readonly machines: number;
  readonly filesScanned: number;
  /**
   * The all-time cost understates the truth because some models have no
   * vendored rate. Their tokens are counted, their dollars are not.
   */
  readonly costIsFloor: boolean;
}

export const EMPTY_CLI_HISTORY_FLEET_VIEW: CliHistoryFleetView = {
  reported: false,
  windows: EMPTY_CLI_USAGE_WINDOWS,
  providers: [],
  scanning: false,
  failed: false,
  pending: false,
  machines: 0,
  filesScanned: 0,
  costIsFloor: false,
};

export interface AccountsUsageEnvironmentGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Null until the machine's first usage read lands, or if it never does. */
  readonly timeZone: string | null;
  /**
   * `YYYY-MM-DD` for "today" **on that machine**, not in the viewer's zone.
   * The daily chart's right edge is the latest of these, so a browser open
   * past a machine's midnight does not draw a phantom empty column.
   */
  readonly localDay: string | null;
  readonly usageAvailable: boolean;
  readonly configAvailable: boolean;
  readonly accounts: ReadonlyArray<AccountUsageRow>;
  /**
   * Configured provider instances this machine has never used and cannot use —
   * not installed, or switched off. Counted rather than listed: they are the
   * built-in defaults for every driver this build ships, so on a machine that
   * runs two of them the other rows are noise that pushes the real accounts
   * off the screen. See `isDormantAccount`.
   */
  readonly dormantAccounts: ReadonlyArray<AccountUsageRow>;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  /**
   * What this machine's CLIs spent outside the fork. Deliberately kept beside
   * `today`/`week` rather than folded into them: those count turns the fork
   * ran, this counts messages found in the CLIs' own stores, and any turn the
   * fork ran through a CLI appears in both.
   */
  readonly cliHistory: CliHistoryMachineView;
}

export interface AccountsUsageView {
  readonly groups: ReadonlyArray<AccountsUsageEnvironmentGroup>;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  readonly accountCount: number;
  /** Set when the machines disagree about which local day "today" is. */
  readonly mixedDays: boolean;
  readonly cliHistory: CliHistoryFleetView;
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

export function addCliUsageTotals(left: CliUsageTotals, right: CliUsageTotals): CliUsageTotals {
  return {
    costUsd: left.costUsd + right.costUsd,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    messages: left.messages + right.messages,
    unpricedMessages: left.unpricedMessages + right.unpricedMessages,
  };
}

function addCliWindows(left: CliUsageWindows, right: CliUsageWindows): CliUsageWindows {
  return {
    today: addCliUsageTotals(left.today, right.today),
    last7Days: addCliUsageTotals(left.last7Days, right.last7Days),
    last30Days: addCliUsageTotals(left.last30Days, right.last30Days),
    allTime: addCliUsageTotals(left.allTime, right.allTime),
  };
}

/** The four windows one CLI reported, in the shape the tiles render. */
export function cliProviderWindows(provider: CliProviderUsage): CliUsageWindows {
  return {
    today: provider.today,
    last7Days: provider.last7Days,
    last30Days: provider.last30Days,
    allTime: provider.allTime,
  };
}

function sumCliWindows(values: Iterable<CliUsageWindows>): CliUsageWindows {
  let total = EMPTY_CLI_USAGE_WINDOWS;
  for (const value of values) total = addCliWindows(total, value);
  return total;
}

/**
 * Normalizes one machine's `cliHistory` into something a component can render
 * without re-deriving the absent/scanning/failed rules at every call site.
 *
 * Every window is summed from the providers rather than read off
 * `CliHistoricalUsage.totals`, so the headline figure is always the sum of the
 * rows underneath it — a total that disagrees with its own breakdown is worse
 * than no total.
 */
export function buildCliHistoryView(
  history: CliHistoricalUsage | null | undefined,
): CliHistoryMachineView {
  if (history === null || history === undefined) return EMPTY_CLI_HISTORY_MACHINE_VIEW;

  const windows = sumCliWindows(history.providers.map(cliProviderWindows));
  const scanning = history.status === "scanning";
  return {
    reported: true,
    status: history.status,
    computedAt: history.computedAt,
    scanning,
    failed: history.status === "failed",
    pending: scanning && history.computedAt === null,
    providers: history.providers,
    windows,
    filesScanned: history.filesScanned,
    hasUsage: windows.allTime.messages > 0,
  };
}

/**
 * Rolls every machine's history into one fleet figure, per provider and in
 * total. Machines that never reported are skipped rather than counted as zero,
 * which is what keeps `machines` honest when half a fleet runs an old server.
 */
export function buildCliHistoryFleetView(
  groups: ReadonlyArray<AccountsUsageEnvironmentGroup>,
): CliHistoryFleetView {
  const reporting = groups.flatMap((group) =>
    group.cliHistory.reported ? [group.cliHistory] : [],
  );
  if (reporting.length === 0) return EMPTY_CLI_HISTORY_FLEET_VIEW;

  const byProvider = new Map<CliUsageProvider, { windows: CliUsageWindows; machines: number }>();
  for (const machine of reporting) {
    for (const provider of machine.providers) {
      const existing = byProvider.get(provider.provider);
      byProvider.set(provider.provider, {
        windows: addCliWindows(
          existing?.windows ?? EMPTY_CLI_USAGE_WINDOWS,
          cliProviderWindows(provider),
        ),
        machines: (existing?.machines ?? 0) + 1,
      });
    }
  }

  const providers = [...byProvider.entries()]
    .map(([provider, entry]) => ({ provider, windows: entry.windows, machines: entry.machines }))
    .sort(
      (left, right) =>
        right.windows.allTime.costUsd - left.windows.allTime.costUsd ||
        right.windows.allTime.messages - left.windows.allTime.messages ||
        left.provider.localeCompare(right.provider),
    );

  const windows = sumCliWindows(providers.map((provider) => provider.windows));
  return {
    reported: true,
    windows,
    providers,
    scanning: reporting.some((machine) => machine.scanning),
    failed: reporting.some((machine) => machine.failed),
    pending: reporting.every((machine) => machine.pending),
    machines: reporting.length,
    filesScanned: reporting.reduce((files, machine) => files + machine.filesScanned, 0),
    costIsFloor: windows.allTime.unpricedMessages > 0,
  };
}

/** Models past this many are folded into one tail row rather than dropped. */
export const CLI_MODEL_ROW_LIMIT = 8;

export interface CliModelRow {
  readonly model: string;
  /** False when no vendored rate matched, which pins this row's cost at 0. */
  readonly priced: boolean;
  readonly totals: CliUsageTotals;
  /** 0-1 against the largest row, for the bar width. */
  readonly share: number;
  /** How many models this row stands for; 1 for everything but the tail. */
  readonly modelCount: number;
}

export interface CliModelRows {
  readonly rows: ReadonlyArray<CliModelRow>;
  /**
   * What `share` measures. Cost, unless every model here is unpriced — a bar
   * chart of zeros ranks nothing, so those fall back to message volume.
   */
  readonly shareBasis: "cost" | "messages";
}

/**
 * Turns the server's cost-sorted model list into bar rows.
 *
 * The tail is folded into a single row instead of being cut: the panel claims
 * to show what a provider spent, so the rows have to still add up to the
 * provider's total no matter where the limit falls.
 */
export function foldCliModelRows(
  models: ReadonlyArray<CliUsageModelTotals>,
  limit: number = CLI_MODEL_ROW_LIMIT,
): CliModelRows {
  const head = models.slice(0, limit);
  const tail = models.slice(limit);

  const entries: Array<{ model: string; priced: boolean; totals: CliUsageTotals; count: number }> =
    head.map((entry) => ({
      model: entry.model,
      priced: entry.priced,
      totals: entry.totals,
      count: 1,
    }));

  if (tail.length > 0) {
    entries.push({
      model: `${tail.length} more models`,
      // The tail is priced when any of its models is: its cost figure is then
      // a real one, even if an incomplete one.
      priced: tail.some((entry) => entry.priced),
      totals: tail.reduce(
        (totals, entry) => addCliUsageTotals(totals, entry.totals),
        EMPTY_CLI_USAGE_TOTALS,
      ),
      count: tail.length,
    });
  }

  const maxCost = Math.max(0, ...entries.map((entry) => entry.totals.costUsd));
  const maxMessages = Math.max(0, ...entries.map((entry) => entry.totals.messages));
  const shareBasis = maxCost > 0 ? "cost" : "messages";
  const denominator = shareBasis === "cost" ? maxCost : maxMessages;

  return {
    shareBasis,
    rows: entries.map((entry) => ({
      model: entry.model,
      priced: entry.priced,
      totals: entry.totals,
      share:
        denominator === 0
          ? 0
          : (shareBasis === "cost" ? entry.totals.costUsd : entry.totals.messages) / denominator,
      modelCount: entry.count,
    })),
  };
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName ?? provider.instanceId;
}

/**
 * A provider instance this machine has never used and could not use today.
 *
 * The server hydrates a default instance for **every** built-in driver, from
 * the schema's defaults, whether or not the machine has that CLI. So a laptop
 * that runs Claude and Codex still reports five accounts, three of them
 * permanently empty. Those three are what this predicate names.
 *
 * The bar is deliberately conjunctive, and the usage half of it comes first:
 * spend that was recorded must never disappear from the panel because a config
 * entry was switched off or a binary was moved. Only an instance with no
 * spend, no rate-limit report, and no way to run is hidden — and even then it
 * is counted and one click away, never silently dropped.
 */
export function isDormantAccount(account: AccountUsageRow): boolean {
  if (account.orphanedUsage) return false;
  if (account.installed && account.enabled) return false;
  if (account.rateLimits !== null || account.lastTurnAt !== null) return false;
  if (account.authStatus === "authenticated") return false;
  return (
    account.today.turns === 0 &&
    account.week.turns === 0 &&
    account.today.costUsd === 0 &&
    account.week.costUsd === 0
  );
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

  // The split is presentational only: both halves stay in the group and the
  // machine's totals are summed over all of them, so hiding a row never
  // changes a number.
  const dormantAccounts = accounts.filter(isDormantAccount);
  const activeAccounts = accounts.filter((account) => !isDormantAccount(account));

  return {
    environmentId: input.environmentId,
    label: input.label,
    timeZone: input.usage?.timeZone ?? null,
    localDay: input.usage?.today ?? null,
    usageAvailable: input.usage !== null,
    configAvailable: input.config !== null,
    accounts: activeAccounts,
    dormantAccounts,
    today: sumTotals(accounts.map((account) => account.today)),
    week: sumTotals(accounts.map((account) => account.week)),
    cliHistory: buildCliHistoryView(input.usage?.cliHistory),
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
    cliHistory: buildCliHistoryFleetView(groups),
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
 * Message counts are shown in full rather than abbreviated. "584,734 unpriced"
 * is a claim a reader can check against their own tooling; "585k" is not.
 */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

/**
 * Share of a window's messages priced at nothing because no vendored rate
 * matched their model, 0-1. Null when the window holds no messages at all,
 * which is not the same as "all of them are priced".
 */
export function unpricedShare(totals: CliUsageTotals): number | null {
  if (totals.messages === 0) return null;
  return totals.unpricedMessages / totals.messages;
}

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

/**
 * "Jun 10 – Jul 25, 2026" for the span a CLI's history covers.
 *
 * The bounds arrive as `YYYY-MM-DD` already resolved in the *reporting*
 * machine's zone, so they are split by hand — parsing them into a `Date` would
 * re-interpret them in the viewer's zone and shift the ends by a day.
 */
export function formatDayRange(firstDay: string | null, lastDay: string | null): string | null {
  const first = parseDay(firstDay);
  const last = parseDay(lastDay);
  if (first === null || last === null) return null;
  if (first.year === last.year && first.month === last.month && first.day === last.day) {
    return `${first.label}, ${first.year}`;
  }
  return first.year === last.year
    ? `${first.label} – ${last.label}, ${last.year}`
    : `${first.label}, ${first.year} – ${last.label}, ${last.year}`;
}

function parseDay(
  value: string | null,
): { year: string; month: number; day: number; label: string } | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, year, monthText, dayText] = match;
  if (year === undefined || monthText === undefined || dayText === undefined) return null;
  const month = Number(monthText);
  const day = Number(dayText);
  const monthName = MONTH_NAMES[month - 1];
  if (monthName === undefined) return null;
  return { year, month, day, label: `${monthName} ${day}` };
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
