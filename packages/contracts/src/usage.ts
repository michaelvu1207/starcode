/**
 * Usage - per-provider-instance rate limits and spend.
 *
 * An "account" in this fork is a provider instance: one configured entry with
 * its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, whose identity (email, plan) the
 * capability probe already reports on `ServerProvider.auth`. This module adds
 * the other half — how much of that account's allowance is left, and what it
 * has spent — folded from provider runtime events the server already receives.
 *
 * Both providers describe rate limits differently (Claude ships a single
 * utilization percentage with a reset instant; Codex ships primary/secondary
 * windows with used percentages). `UsageRateLimitWindow` is the shared shape
 * both normalize into, so the UI renders one kind of bar.
 *
 * @module Usage
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** Days of history the usage snapshot carries, including today. */
export const USAGE_SNAPSHOT_DAYS = 14;
/** Days folded into the "this week" rollup, including today. */
export const USAGE_WEEK_DAYS = 7;
/** Turn rows older than this are pruned; nothing reads them. */
export const USAGE_RETENTION_DAYS = 120;

/**
 * How close the account is to being cut off. Normalized across providers:
 * Claude reports `allowed | allowed_warning | rejected` directly, Codex only
 * reports *that* a limit was reached, which maps to `rejected`.
 */
export const UsageRateLimitStatus = Schema.Literals(["allowed", "warning", "rejected"]);
export type UsageRateLimitStatus = typeof UsageRateLimitStatus.Type;

/**
 * One rate-limit window. `usedPercent` is 0-100 (not a fraction) and is
 * clamped on ingest, because the providers disagree about the units they send
 * and a bar that renders past 100% is worse than a saturated one.
 *
 * It is null when the provider reported a window without a consumption figure
 * — Claude sends a bare reset instant until the account approaches its limit.
 * Null is not zero: zero claims full headroom, null admits we do not know.
 */
export const UsageRateLimitWindow = Schema.Struct({
  /** Provider-native window key, e.g. `five_hour`, `seven_day`, `primary`. */
  key: TrimmedNonEmptyString,
  /** Human label for the bar; derived from `key` when the provider sends none. */
  label: TrimmedNonEmptyString,
  usedPercent: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resetsAt: Schema.NullOr(IsoDateTime),
  windowMinutes: Schema.NullOr(PositiveInt),
});
export type UsageRateLimitWindow = typeof UsageRateLimitWindow.Type;

export const UsageRateLimitSnapshot = Schema.Struct({
  status: UsageRateLimitStatus,
  /** Plan tier as the rate-limit event reports it (Codex only today). */
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(UsageRateLimitWindow),
  /** When the provider last told us this; not when we last asked. */
  observedAt: IsoDateTime,
});
export type UsageRateLimitSnapshot = typeof UsageRateLimitSnapshot.Type;

/**
 * Totals for one local calendar day on the reporting machine. Cost is USD as
 * the provider reported it — Claude emits `total_cost_usd` per turn, Codex
 * emits none, so a Codex instance shows tokens with a zero cost rather than a
 * wrong one.
 */
export const UsageTotals = Schema.Struct({
  turns: NonNegativeInt,
  costUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
});
export type UsageTotals = typeof UsageTotals.Type;

export const UsageDayTotals = Schema.Struct({
  /** `YYYY-MM-DD` in the reporting machine's local time zone. */
  day: TrimmedNonEmptyString,
  totals: UsageTotals,
});
export type UsageDayTotals = typeof UsageDayTotals.Type;

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  turns: 0,
  costUsd: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * Usage for one provider instance. `providerInstanceId` joins to
 * `ServerProvider.instanceId`, which is where the account's email and plan
 * live — this snapshot deliberately does not restate them, so there is one
 * source of truth for account identity.
 */
export const ProviderInstanceUsage = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  rateLimits: Schema.NullOr(UsageRateLimitSnapshot),
  today: UsageTotals,
  week: UsageTotals,
  days: Schema.Array(UsageDayTotals),
  lastTurnAt: Schema.NullOr(IsoDateTime),
});
export type ProviderInstanceUsage = typeof ProviderInstanceUsage.Type;

/**
 * Which CLI a historical figure came from. This is the *tool* that wrote the
 * session file, not the model vendor: a Codex rollout that called an Anthropic
 * model is still `codex`, because the file it lives in is Codex's.
 */
export const CliUsageProvider = Schema.Literals(["claude", "codex"]);
export type CliUsageProvider = typeof CliUsageProvider.Type;

/**
 * Historical totals read off a CLI's own session store.
 *
 * Separate from `UsageTotals` on purpose. That one counts *turns* the fork
 * itself ran and trusts the provider's own cost figure; this one counts
 * *messages* found on disk and prices them from a vendored rate table. They
 * describe different things and must never be silently summed.
 *
 * `unpricedMessages` is the honesty valve: a model with no vendored rate still
 * contributes its tokens here, but contributes nothing to `costUsd`. A caller
 * that sees a non-zero count knows the cost is a floor, not a total.
 */
export const CliUsageTotals = Schema.Struct({
  costUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  messages: NonNegativeInt,
  unpricedMessages: NonNegativeInt,
});
export type CliUsageTotals = typeof CliUsageTotals.Type;

export const EMPTY_CLI_USAGE_TOTALS: CliUsageTotals = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  messages: 0,
  unpricedMessages: 0,
};

export const CliUsageModelTotals = Schema.Struct({
  /** Model id exactly as the session file spelled it. */
  model: TrimmedNonEmptyString,
  /** False when no vendored rate matched, which forces `costUsd` to 0. */
  priced: Schema.Boolean,
  totals: CliUsageTotals,
});
export type CliUsageModelTotals = typeof CliUsageModelTotals.Type;

/**
 * One local calendar day of a CLI's history, in the reporting machine's zone.
 *
 * Emitted only for days inside the 30-day chart window that carry usage — the
 * full history is a year of rows per provider per machine, and nothing renders
 * it. A missing day means "no messages", which the chart draws as a gap in a
 * dense axis rather than as an absent bar.
 */
export const CliUsageDayTotals = Schema.Struct({
  /** `YYYY-MM-DD` in the reporting machine's local time zone. */
  day: TrimmedNonEmptyString,
  totals: CliUsageTotals,
});
export type CliUsageDayTotals = typeof CliUsageDayTotals.Type;

/**
 * One CLI's history on one machine, in the four windows the panel shows.
 *
 * Windows are cumulative from today backwards and are computed in the
 * reporting machine's zone, matching `EnvironmentUsageSnapshot.timeZone`.
 */
export const CliProviderUsage = Schema.Struct({
  provider: CliUsageProvider,
  allTime: CliUsageTotals,
  last30Days: CliUsageTotals,
  last7Days: CliUsageTotals,
  today: CliUsageTotals,
  /** Costliest first, so a truncated render still shows what dominates. */
  models: Schema.Array(CliUsageModelTotals),
  /**
   * Per-day totals for the 30-day window above, oldest first.
   *
   * Additive over the four cumulative windows rather than a replacement for
   * them: `last30Days` is still the figure the tiles read, and summing `days`
   * reproduces it. `optionalKey` so a server that predates the daily chart
   * omits the field instead of sending an empty array a client would read as
   * "thirty days of nothing".
   */
  days: Schema.optionalKey(Schema.Array(CliUsageDayTotals)),
  /** `YYYY-MM-DD` bounds of the days that carry usage; null when none do. */
  firstDay: Schema.NullOr(TrimmedNonEmptyString),
  lastDay: Schema.NullOr(TrimmedNonEmptyString),
  sessionFiles: NonNegativeInt,
});
export type CliProviderUsage = typeof CliProviderUsage.Type;

/**
 * Whether the numbers below are final.
 *
 * `scanning` is a real state a client must render rather than hide: the first
 * pass over a multi-gigabyte store takes tens of seconds, and the endpoint
 * answers immediately with whatever the last completed pass knew.
 */
export const CliUsageScanStatus = Schema.Literals(["scanning", "ready", "failed"]);
export type CliUsageScanStatus = typeof CliUsageScanStatus.Type;

export const CliHistoricalUsage = Schema.Struct({
  status: CliUsageScanStatus,
  /** End of the last completed pass; null until one finishes. */
  computedAt: Schema.NullOr(IsoDateTime),
  providers: Schema.Array(CliProviderUsage),
  totals: CliUsageTotals,
  filesScanned: NonNegativeInt,
});
export type CliHistoricalUsage = typeof CliHistoricalUsage.Type;

export const EnvironmentUsageSnapshot = Schema.Struct({
  generatedAt: IsoDateTime,
  /**
   * IANA zone the day buckets were computed in — the *server's* zone, not the
   * viewer's. A hub aggregating four machines is aggregating four midnights,
   * and the UI says so rather than pretending otherwise.
   */
  timeZone: TrimmedNonEmptyString,
  today: TrimmedNonEmptyString,
  instances: Schema.Array(ProviderInstanceUsage),
  totalsToday: UsageTotals,
  totalsWeek: UsageTotals,
  /**
   * What the machine's CLIs spent before, or outside, this fork.
   *
   * `optionalKey` in both directions on purpose: a newer client reading an
   * older server must tolerate the key being absent, and an older client
   * reading a newer server ignores it. Null means the machine has the feature
   * but has nothing to report yet.
   *
   * Never add this into `totalsToday`/`totalsWeek`. Those count turns this
   * fork ran; this counts messages found in the CLIs' own stores, and the two
   * overlap for any turn the fork ran through a CLI that logs to disk.
   */
  cliHistory: Schema.optionalKey(Schema.NullOr(CliHistoricalUsage)),
});
export type EnvironmentUsageSnapshot = typeof EnvironmentUsageSnapshot.Type;
