/**
 * Folding parsed session files into the panel's numbers.
 *
 * Pure, so the arithmetic that turns 800,000 messages into eight totals can be
 * tested without touching a filesystem.
 *
 * The one subtlety is that deduplication has to happen *here* rather than in
 * the parser. Claude replays earlier messages into a resumed session's new
 * file, so a copy of a message can live in a file the parser will never see in
 * the same call. Per-file parsing collapses the streaming duplicates (98% of
 * them); this pass collapses the rest.
 *
 * @module CliUsageAggregate
 */
import {
  type CliProviderUsage,
  type CliUsageDayTotals,
  type CliUsageModelTotals,
  type CliUsageProvider,
  type CliUsageTotals,
  EMPTY_CLI_USAGE_TOTALS,
} from "@starcode/contracts";

import type { KeyedMessage, MessageTokens, ParsedFileUsage, UsageBucket } from "./parse.ts";
import { codexFastMultiplier, costOf, rateFor } from "./pricing.ts";

/** A parsed file paired with the provider whose store it came from. */
export interface ProviderFileUsage {
  readonly provider: CliUsageProvider;
  readonly parsed: ParsedFileUsage;
}

/**
 * Operator-assigned stand-in rates, `provider -> model -> pricedAs`.
 *
 * Consulted only where the vendored table has nothing, never over it. That
 * ordering is the whole safety property: an alias written for a model upstream
 * later adds cannot silently keep costing it at the stand-in rate.
 */
export type ModelAliasMap = ReadonlyMap<CliUsageProvider, ReadonlyMap<string, string>>;

export const EMPTY_MODEL_ALIASES: ModelAliasMap = new Map();

export interface AggregateOptions {
  /** `YYYY-MM-DD` in the reporting machine's zone. */
  readonly today: string;
  /** Inclusive lower bound of the 7-day window. */
  readonly earliest7Day: string;
  /** Inclusive lower bound of the 30-day window. */
  readonly earliest30Day: string;
  /** True when Codex bills at OpenAI's priority tier on this machine. */
  readonly codexPriorityTier: boolean;
  /** Defaults to none, so an aggregate without aliases needs no argument. */
  readonly modelAliases?: ModelAliasMap;
}

interface MutableTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messages: number;
  unpricedMessages: number;
}

const emptyMutable = (): MutableTotals => ({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  messages: 0,
  unpricedMessages: 0,
});

const accumulate = (
  into: MutableTotals,
  tokens: MessageTokens,
  messages: number,
  costUsd: number,
  priced: boolean,
): void => {
  into.costUsd += costUsd;
  into.inputTokens += tokens.inputTokens;
  into.outputTokens += tokens.outputTokens;
  into.cacheWriteTokens += tokens.cacheWrite5mTokens + tokens.cacheWrite1hTokens;
  into.cacheReadTokens += tokens.cacheReadTokens;
  into.messages += messages;
  if (!priced) into.unpricedMessages += messages;
};

const freeze = (totals: MutableTotals): CliUsageTotals => ({
  costUsd: totals.costUsd,
  inputTokens: Math.round(totals.inputTokens),
  outputTokens: Math.round(totals.outputTokens),
  cacheWriteTokens: Math.round(totals.cacheWriteTokens),
  cacheReadTokens: Math.round(totals.cacheReadTokens),
  messages: totals.messages,
  unpricedMessages: totals.unpricedMessages,
});

export const addCliUsageTotals = (left: CliUsageTotals, right: CliUsageTotals): CliUsageTotals => ({
  costUsd: left.costUsd + right.costUsd,
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  messages: left.messages + right.messages,
  unpricedMessages: left.unpricedMessages + right.unpricedMessages,
});

const totalTokensOf = (tokens: MessageTokens): number =>
  tokens.inputTokens +
  tokens.outputTokens +
  tokens.cacheWrite5mTokens +
  tokens.cacheWrite1hTokens +
  tokens.cacheReadTokens;

interface ModelAccumulator {
  readonly priced: boolean;
  /** The aliased model that paid for it, or null when the table did. */
  readonly pricedAs: string | null;
  readonly totals: MutableTotals;
  /** The same model inside the 30-day window, for the panel's breakdown. */
  readonly last30Days: MutableTotals;
}

interface ProviderAccumulator {
  readonly allTime: MutableTotals;
  readonly last30Days: MutableTotals;
  readonly last7Days: MutableTotals;
  readonly today: MutableTotals;
  readonly models: Map<string, ModelAccumulator>;
  /** Per-day totals inside the 30-day window; days outside it are not kept. */
  readonly days: Map<string, MutableTotals>;
  firstDay: string | null;
  lastDay: string | null;
  files: number;
}

const emptyProviderAccumulator = (): ProviderAccumulator => ({
  allTime: emptyMutable(),
  last30Days: emptyMutable(),
  last7Days: emptyMutable(),
  today: emptyMutable(),
  models: new Map(),
  days: new Map(),
  firstDay: null,
  lastDay: null,
  files: 0,
});

/**
 * Folds one message (or one pre-folded bucket) into every window it belongs to.
 *
 * Windows are cumulative rather than exclusive — a message from today counts in
 * today, the last 7 days, the last 30, and all time — because that is what the
 * labels claim and what a reader comparing them expects.
 */
const foldInto = (
  accumulator: ProviderAccumulator,
  provider: CliUsageProvider,
  day: string,
  model: string,
  tokens: MessageTokens,
  messages: number,
  options: AggregateOptions,
): void => {
  // The alias is a fallback, not an override: a model the vendored table
  // prices is priced by the table even if an alias names it.
  const vendored = rateFor(provider, model);
  const alias =
    vendored === null ? (options.modelAliases?.get(provider)?.get(model) ?? null) : null;
  const pricingModel = alias ?? model;
  const rate = vendored ?? (alias === null ? null : rateFor(provider, alias));
  const multiplier =
    provider === "codex" && options.codexPriorityTier ? codexFastMultiplier(pricingModel) : 1;
  // `tokens` is already the sum over `messages` messages for a pre-folded
  // bucket, so the rate applies to it once, not once per message.
  const costUsd = costOf(rate, tokens, multiplier);
  const priced = rate !== null;

  accumulate(accumulator.allTime, tokens, messages, costUsd, priced);
  const withinMonth = day >= options.earliest30Day;
  if (withinMonth) {
    accumulate(accumulator.last30Days, tokens, messages, costUsd, priced);
    let dayEntry = accumulator.days.get(day);
    if (dayEntry === undefined) {
      dayEntry = emptyMutable();
      accumulator.days.set(day, dayEntry);
    }
    accumulate(dayEntry, tokens, messages, costUsd, priced);
  }
  if (day >= options.earliest7Day) {
    accumulate(accumulator.last7Days, tokens, messages, costUsd, priced);
  }
  if (day === options.today) {
    accumulate(accumulator.today, tokens, messages, costUsd, priced);
  }

  let modelEntry = accumulator.models.get(model);
  if (modelEntry === undefined) {
    // An alias that resolves to nothing — pointed at a model this build does
    // not price — leaves the row exactly as unpriced as it was, rather than
    // claiming a provenance that bought it no dollars.
    modelEntry = {
      priced,
      pricedAs: priced ? alias : null,
      totals: emptyMutable(),
      last30Days: emptyMutable(),
    };
    accumulator.models.set(model, modelEntry);
  }
  accumulate(modelEntry.totals, tokens, messages, costUsd, priced);
  if (withinMonth) accumulate(modelEntry.last30Days, tokens, messages, costUsd, priced);

  if (accumulator.firstDay === null || day < accumulator.firstDay) accumulator.firstDay = day;
  if (accumulator.lastDay === null || day > accumulator.lastDay) accumulator.lastDay = day;
};

const toProviderUsage = (
  provider: CliUsageProvider,
  accumulator: ProviderAccumulator,
): CliProviderUsage => {
  const models: Array<CliUsageModelTotals> = [...accumulator.models.entries()]
    .map(([model, entry]) => ({
      model,
      priced: entry.priced,
      pricedAs: entry.pricedAs,
      totals: freeze(entry.totals),
      last30Days: freeze(entry.last30Days),
    }))
    .sort(
      (left, right) =>
        right.totals.costUsd - left.totals.costUsd ||
        right.totals.messages - left.totals.messages ||
        left.model.localeCompare(right.model),
    );

  // Oldest first. The chart reads left to right and a reversed series would be
  // a silent off-by-a-month rather than a visible error.
  const days: Array<CliUsageDayTotals> = [...accumulator.days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, totals]) => ({ day, totals: freeze(totals) }));

  return {
    provider,
    allTime: freeze(accumulator.allTime),
    last30Days: freeze(accumulator.last30Days),
    last7Days: freeze(accumulator.last7Days),
    today: freeze(accumulator.today),
    models,
    days,
    firstDay: accumulator.firstDay,
    lastDay: accumulator.lastDay,
    sessionFiles: accumulator.files,
  };
};

export interface AggregateResult {
  readonly providers: ReadonlyArray<CliProviderUsage>;
  readonly totals: CliUsageTotals;
}

/**
 * Folds every parsed file into per-provider windows.
 *
 * Keyed Claude messages are collected across all files first and reduced to one
 * survivor per key — the copy with the most tokens, which is the finished one —
 * before any of them is priced.
 */
export const aggregateCliUsage = (
  files: Iterable<ProviderFileUsage>,
  options: AggregateOptions,
): AggregateResult => {
  const accumulators = new Map<CliUsageProvider, ProviderAccumulator>();
  const accumulatorFor = (provider: CliUsageProvider): ProviderAccumulator => {
    let existing = accumulators.get(provider);
    if (existing === undefined) {
      existing = emptyProviderAccumulator();
      accumulators.set(provider, existing);
    }
    return existing;
  };

  // Global dedup pool, keyed by provider so two CLIs can never collide.
  const survivors = new Map<string, { provider: CliUsageProvider; message: KeyedMessage }>();
  const pending: Array<{ provider: CliUsageProvider; bucket: UsageBucket }> = [];

  for (const file of files) {
    accumulatorFor(file.provider).files += 1;
    for (const message of file.parsed.keyed) {
      const key = `${file.provider} ${message.dedupKey}`;
      const previous = survivors.get(key);
      if (previous === undefined || totalTokensOf(message) > totalTokensOf(previous.message)) {
        survivors.set(key, { provider: file.provider, message });
      }
    }
    for (const bucket of file.parsed.buckets) {
      pending.push({ provider: file.provider, bucket });
    }
  }

  for (const { provider, message } of survivors.values()) {
    foldInto(accumulatorFor(provider), provider, message.day, message.model, message, 1, options);
  }
  for (const { provider, bucket } of pending) {
    foldInto(
      accumulatorFor(provider),
      provider,
      bucket.day,
      bucket.model,
      bucket,
      bucket.messages,
      options,
    );
  }

  const providers = [...accumulators.entries()]
    .map(([provider, accumulator]) => toProviderUsage(provider, accumulator))
    .sort((left, right) => left.provider.localeCompare(right.provider));

  return {
    providers,
    totals: providers.reduce(
      (totals, provider) => addCliUsageTotals(totals, provider.allTime),
      EMPTY_CLI_USAGE_TOTALS,
    ),
  };
};
