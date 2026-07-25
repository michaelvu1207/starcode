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
});
export type EnvironmentUsageSnapshot = typeof EnvironmentUsageSnapshot.Type;
