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
  type CliUsageDayTotals,
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
  type UsageRateLimitStatus,
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
  /** The trailing hour, or zeros when this machine's server does not report it. */
  readonly lastHour: UsageTotals;
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
  /**
   * Daily spend inside the 30-day window, ascending, every reporting machine
   * merged by local day. Empty when no machine sent a series, which is what an
   * older server does — a caller renders no sparkline rather than a flat zero.
   */
  readonly days: ReadonlyArray<CliUsageDayTotals>;
  /**
   * This provider's models scoped to the 30-day window and re-sorted by that
   * window's cost, costliest first. Empty when no machine can split a model by
   * window; never silently backfilled from the all-time figures, which would
   * put an all-time breakdown under a 30-day heading.
   */
  readonly models: ReadonlyArray<CliUsageModelTotals>;
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
   * The 30-day cost understates the truth because some models have no vendored
   * rate. Their tokens are counted, their dollars are not. Keyed off the window
   * the panel actually shows: a floor warning about all-time spend, printed
   * under a 30-day figure that happens to be fully priced, is a false alarm.
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
  readonly usageAvailable: boolean;
  readonly configAvailable: boolean;
  readonly accounts: ReadonlyArray<AccountUsageRow>;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  /**
   * What this machine spent in the trailing hour, and whether it is in a
   * position to say. A server predating the window omits it; that machine is
   * excluded from the fleet rate rather than counted as an idle one, because a
   * busy machine reporting nothing would otherwise drag the rate down.
   */
  readonly lastHour: UsageTotals;
  readonly lastHourReported: boolean;
  /**
   * What this machine's CLIs spent outside the fork. Deliberately kept beside
   * `today`/`week` rather than folded into them: those count turns the fork
   * ran, this counts messages found in the CLIs' own stores, and any turn the
   * fork ran through a CLI appears in both.
   */
  readonly cliHistory: CliHistoryMachineView;
}

/**
 * One account's headroom, flattened out of its machine.
 *
 * The condensed panel shows spend aggregated across accounts, so this is the
 * only place accounts stay individually visible: a limit belongs to one
 * account and cannot be summed with another's.
 */
export interface AccountLimitRow {
  readonly instanceId: string;
  readonly displayName: string;
  /** Which machine it runs on; rendered only when the fleet has more than one. */
  readonly machineLabel: string;
  readonly driver: string;
  readonly planLabel: string | null;
  /** Null when the provider has never reported a limit for this account. */
  readonly status: UsageRateLimitStatus | null;
  readonly peakUsedPercent: number | null;
  /** When the window behind `peakUsedPercent` resets, if the provider said. */
  readonly resetsAt: string | null;
}

export interface AccountsUsageView {
  readonly groups: ReadonlyArray<AccountsUsageEnvironmentGroup>;
  readonly today: UsageTotals;
  readonly week: UsageTotals;
  /** Every reporting machine's trailing hour, summed — the fleet burn rate. */
  readonly lastHour: UsageTotals;
  /** True once at least one connected machine reports the window at all. */
  readonly lastHourReported: boolean;
  /** How many machines that rate is drawn from; never more than `groups`. */
  readonly lastHourMachines: number;
  /** Accounts that ran at least one turn inside the window. */
  readonly lastHourActiveAccounts: number;
  readonly accountCount: number;
  /** Set when the machines disagree about which local day "today" is. */
  readonly mixedDays: boolean;
  readonly cliHistory: CliHistoryFleetView;
  /** Every account's headroom, closest to its limit first. */
  readonly limitRows: ReadonlyArray<AccountLimitRow>;
  /**
   * The latest local day any machine reports, which is the right edge of the
   * daily series. Null when no machine has answered yet — a sparkline drawn
   * against a guessed edge would slide the whole shape.
   */
  readonly latestDay: string | null;
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
 * Merges every machine's daily series into one, keyed by local day.
 *
 * Machines in different zones cut their days at different instants, so a day
 * here is the union of up to N slightly-offset local days. That is the same
 * approximation the cumulative windows already make, and `mixedDays` on the
 * view is what tells a caller to say so.
 */
function mergeCliDays(
  series: Iterable<ReadonlyArray<CliUsageDayTotals>>,
): ReadonlyArray<CliUsageDayTotals> {
  const byDay = new Map<string, { costUsd: number; messages: number }>();
  for (const days of series) {
    for (const entry of days) {
      const existing = byDay.get(entry.day);
      byDay.set(entry.day, {
        costUsd: (existing?.costUsd ?? 0) + entry.costUsd,
        messages: (existing?.messages ?? 0) + entry.messages,
      });
    }
  }
  return [...byDay.entries()]
    .map(([day, entry]) => ({ day, costUsd: entry.costUsd, messages: entry.messages }))
    .sort((left, right) => left.day.localeCompare(right.day));
}

/**
 * Every machine's models for one provider, scoped to the 30-day window.
 *
 * Models whose entry carries no `last30Days` are dropped rather than folded in
 * at their all-time figure: a server that cannot split by window contributes
 * nothing here, and the caller shows no breakdown instead of a mislabelled one.
 * A model is priced when any machine priced it — an unpriced entry contributes
 * real tokens and no dollars either way.
 */
function mergeCliWindowModels(
  perMachine: Iterable<ReadonlyArray<CliUsageModelTotals>>,
): ReadonlyArray<CliUsageModelTotals> {
  const byModel = new Map<string, { priced: boolean; totals: CliUsageTotals }>();
  for (const models of perMachine) {
    for (const entry of models) {
      const window = entry.last30Days;
      if (window === undefined) continue;
      const existing = byModel.get(entry.model);
      byModel.set(entry.model, {
        priced: (existing?.priced ?? false) || entry.priced,
        totals: addCliUsageTotals(existing?.totals ?? EMPTY_CLI_USAGE_TOTALS, window),
      });
    }
  }
  return [...byModel.entries()]
    .map(([model, entry]) => ({ model, priced: entry.priced, totals: entry.totals }))
    .sort(
      (left, right) =>
        right.totals.costUsd - left.totals.costUsd ||
        right.totals.messages - left.totals.messages ||
        left.model.localeCompare(right.model),
    );
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

  interface ProviderAccumulator {
    windows: CliUsageWindows;
    machines: number;
    days: Array<ReadonlyArray<CliUsageDayTotals>>;
    models: Array<ReadonlyArray<CliUsageModelTotals>>;
  }
  const byProvider = new Map<CliUsageProvider, ProviderAccumulator>();
  for (const machine of reporting) {
    for (const provider of machine.providers) {
      const existing = byProvider.get(provider.provider);
      byProvider.set(provider.provider, {
        windows: addCliWindows(
          existing?.windows ?? EMPTY_CLI_USAGE_WINDOWS,
          cliProviderWindows(provider),
        ),
        machines: (existing?.machines ?? 0) + 1,
        days: [...(existing?.days ?? []), provider.days ?? []],
        models: [...(existing?.models ?? []), provider.models],
      });
    }
  }

  const providers = [...byProvider.entries()]
    .map(([provider, entry]) => ({
      provider,
      windows: entry.windows,
      machines: entry.machines,
      days: mergeCliDays(entry.days),
      models: mergeCliWindowModels(entry.models),
    }))
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
    costIsFloor: windows.last30Days.unpricedMessages > 0,
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
      lastHour: usage?.lastHour ?? EMPTY_USAGE_TOTALS,
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
      lastHour: usage.lastHour ?? EMPTY_USAGE_TOTALS,
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
    // Read off the snapshot rather than summed from the accounts, so the key's
    // absence stays visible: summing rows that all defaulted to zero would
    // manufacture a confident "$0.00 an hour" out of a server that never said
    // anything of the kind.
    lastHour: input.usage?.totalsLastHour ?? EMPTY_USAGE_TOTALS,
    lastHourReported: input.usage?.totalsLastHour !== undefined,
    cliHistory: buildCliHistoryView(input.usage?.cliHistory),
  };
}

/**
 * Flattens every machine's accounts into one headroom list.
 *
 * An orphaned instance — spend recorded against a provider entry that is no
 * longer configured — is carried only when it still reports a limit. A deleted
 * account with nothing to say about headroom is noise on a page this small,
 * whereas one that is still rate-limited is exactly what a reader needs.
 *
 * Ordering is by how close the account is to being cut off. Accounts the
 * provider has said nothing about sort last: unknown is not zero, but it is
 * also not urgent.
 */
export function buildAccountLimitRows(
  groups: ReadonlyArray<AccountsUsageEnvironmentGroup>,
): ReadonlyArray<AccountLimitRow> {
  const rows = groups.flatMap((group) =>
    group.accounts.flatMap((account): Array<AccountLimitRow> => {
      const rateLimits = account.rateLimits;
      if (account.orphanedUsage && rateLimits === null) return [];
      const peak = peakUsedPercent(rateLimits);
      const windows = rateLimits?.windows ?? [];
      // The reset that matters is the one on the window driving the peak, not
      // whichever the provider happened to list first.
      const peakWindow =
        peak === null ? undefined : windows.find((window) => window.usedPercent === peak);
      const resetsAt =
        peakWindow?.resetsAt ??
        windows.find((window) => window.resetsAt !== null)?.resetsAt ??
        null;
      return [
        {
          instanceId: account.instanceId,
          displayName: account.displayName,
          machineLabel: group.label,
          driver: account.driver,
          planLabel: account.planLabel,
          status: rateLimits?.status ?? null,
          peakUsedPercent: peak,
          resetsAt,
        },
      ];
    }),
  );

  return rows.sort((left, right) => {
    if (left.peakUsedPercent === null || right.peakUsedPercent === null) {
      if (left.peakUsedPercent !== right.peakUsedPercent) {
        return left.peakUsedPercent === null ? 1 : -1;
      }
    } else if (left.peakUsedPercent !== right.peakUsedPercent) {
      return right.peakUsedPercent - left.peakUsedPercent;
    }
    return (
      left.machineLabel.localeCompare(right.machineLabel) ||
      left.displayName.localeCompare(right.displayName) ||
      left.instanceId.localeCompare(right.instanceId)
    );
  });
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

  const reportingHour = groups.filter((group) => group.lastHourReported);

  return {
    groups,
    today: sumTotals(groups.map((group) => group.today)),
    week: sumTotals(groups.map((group) => group.week)),
    lastHour: sumTotals(reportingHour.map((group) => group.lastHour)),
    lastHourReported: reportingHour.length > 0,
    lastHourMachines: reportingHour.length,
    lastHourActiveAccounts: reportingHour.reduce(
      (count, group) =>
        count + group.accounts.filter((account) => account.lastHour.turns > 0).length,
      0,
    ),
    accountCount: groups.reduce((count, group) => count + group.accounts.length, 0),
    mixedDays: days.size > 1,
    cliHistory: buildCliHistoryFleetView(groups),
    limitRows: buildAccountLimitRows(groups),
    latestDay: [...days].sort().at(-1) ?? null,
  };
}

/** Days the sparkline spans, matching the 30-day window it sits under. */
export const CLI_SPARK_DAYS = 30;

export interface CliSparkBar {
  readonly day: string;
  readonly costUsd: number;
  readonly messages: number;
  /** 0-1 against the tallest bar in the series; 0 when nothing was spent. */
  readonly share: number;
}

/**
 * A dense, fixed-width daily series ending on `latestDay`.
 *
 * The wire format omits days with no usage, so they are filled back in here:
 * a sparkline that silently closes its gaps would turn a week off into a week
 * of steady spend. Pinning the right edge to the latest day any machine
 * reports — rather than to the last day that carries usage — is what keeps
 * "nothing since Tuesday" visible as a run of empty bars.
 */
export function buildCliSparkSeries(
  days: ReadonlyArray<CliUsageDayTotals>,
  latestDay: string | null,
  span: number = CLI_SPARK_DAYS,
): ReadonlyArray<CliSparkBar> {
  const edge = latestDay ?? days.at(-1)?.day ?? null;
  if (edge === null || days.length === 0) return [];

  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const bars: Array<Omit<CliSparkBar, "share">> = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = shiftDay(edge, -offset);
    if (day === null) continue;
    const entry = byDay.get(day);
    bars.push({ day, costUsd: entry?.costUsd ?? 0, messages: entry?.messages ?? 0 });
  }

  const peak = Math.max(0, ...bars.map((bar) => bar.costUsd));
  return bars.map((bar) => ({ ...bar, share: peak === 0 ? 0 : bar.costUsd / peak }));
}

/**
 * `YYYY-MM-DD` shifted by whole days.
 *
 * Parsed and formatted in UTC on purpose: these are calendar labels the
 * reporting machine already resolved in its own zone, and round-tripping them
 * through the viewer's zone would move the ends by a day.
 */
function shiftDay(day: string, offsetDays: number): string | null {
  const parsed = parseDay(day);
  if (parsed === null) return null;
  const shifted = new Date(
    Date.UTC(Number(parsed.year), parsed.month - 1, parsed.day + offsetDays),
  );
  return Number.isNaN(shifted.getTime()) ? null : shifted.toISOString().slice(0, 10);
}

/** Every token a CLI window counted, cache traffic included. */
export function cliTotalTokens(totals: CliUsageTotals): number {
  return (
    totals.inputTokens + totals.outputTokens + totals.cacheWriteTokens + totals.cacheReadTokens
  );
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
  // A 30-day fleet total runs to the billions, and "4200M" is a number a
  // reader has to stop and count zeros on.
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(value < 10_000_000_000 ? 1 : 0)}B`;
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
