/**
 * Vendored model rates for costing historical CLI usage.
 *
 * The CLIs' session files record tokens, not money — modern Claude Code writes
 * no `costUSD` field at all — so every historical dollar on the accounts panel
 * is computed here. `ccusage` solves the same problem by fetching LiteLLM's
 * price list at runtime; this fork does not, because a usage panel that reports
 * different totals depending on whether the machine had network is worse than
 * one that reports a stable number and admits what it could not price.
 *
 * The consequence is that this table goes stale, and the design makes staleness
 * visible rather than silent: an unmatched model is **never** guessed at and
 * never priced by analogy to a similar name. Its tokens are still counted and
 * it is reported through `unpricedMessages`, so a total that is missing a model
 * reads as "at least this much" instead of quietly under-reporting.
 *
 * Rates are USD per token, transcribed from LiteLLM's
 * `model_prices_and_context_window.json` (the list `ccusage` itself reads) and
 * verified against a live `ccusage` run over this machine's real store.
 *
 * @module CliUsagePricing
 */
import type { CliUsageProvider } from "@t3tools/contracts";

/**
 * What one message costs, per token.
 *
 * `cacheWrite1h` is the term most implementations miss. Anthropic bills a
 * one-hour cache write at twice the input rate, the CLIs record 5-minute and
 * one-hour writes as separate fields, and on this machine most cache writes are
 * the one-hour kind — pricing them all at the 5-minute rate understates heavy
 * sessions by a third.
 *
 * OpenAI does not charge for cache writes at all, so Codex entries carry zero
 * in both cache-write fields rather than being a different shape.
 */
export interface ModelRate {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
}

/** Rates are quoted per million tokens; this is the only place that is true. */
const perMillion = (
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
): ModelRate => ({
  input: input / 1_000_000,
  output: output / 1_000_000,
  cacheWrite5m: cacheWrite5m / 1_000_000,
  cacheWrite1h: cacheWrite1h / 1_000_000,
  cacheRead: cacheRead / 1_000_000,
});

/**
 * Anthropic models, keyed exactly as Claude Code writes `message.model`.
 *
 * Both the bare alias and the dated release id are listed where the store
 * contains both: matching is exact, so an alias is not a prefix of anything.
 */
const CLAUDE_RATES: Readonly<Record<string, ModelRate>> = {
  "claude-fable-5": perMillion(10, 50, 12.5, 20, 1.0),
  "claude-opus-5": perMillion(5, 25, 6.25, 10, 0.5),
  "claude-sonnet-5": perMillion(2, 10, 2.5, 4, 0.2),
  "claude-opus-4-8": perMillion(5, 25, 6.25, 10, 0.5),
  "claude-opus-4-7": perMillion(5, 25, 6.25, 10, 0.5),
  "claude-opus-4-6": perMillion(5, 25, 6.25, 10, 0.5),
  "claude-opus-4-5": perMillion(5, 25, 6.25, 10, 0.5),
  "claude-opus-4-5-20251101": perMillion(5, 25, 6.25, 10, 0.5),
  "claude-opus-4-1": perMillion(15, 75, 18.75, 30, 1.5),
  "claude-opus-4-1-20250805": perMillion(15, 75, 18.75, 30, 1.5),
  "claude-opus-4-20250514": perMillion(15, 75, 18.75, 30, 1.5),
  "claude-4-opus-20250514": perMillion(15, 75, 18.75, 30, 1.5),
  "claude-sonnet-4-6": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-sonnet-4-5": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-sonnet-4-5-20250929": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-sonnet-4-20250514": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-4-sonnet-20250514": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-haiku-4-5": perMillion(1, 5, 1.25, 2, 0.1),
  "claude-haiku-4-5-20251001": perMillion(1, 5, 1.25, 2, 0.1),
  "claude-3-7-sonnet-20250219": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-3-5-sonnet-20241022": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-3-5-sonnet-20240620": perMillion(3, 15, 3.75, 6, 0.3),
  "claude-3-5-haiku-20241022": perMillion(0.8, 4, 1.0, 1.6, 0.08),
  // The two below carry LiteLLM's one-hour cache rate verbatim. It is not 2x
  // input the way every later model's is, and it is copied rather than
  // "corrected" so this table stays a transcription of the source of truth.
  "claude-3-opus-20240229": perMillion(15, 75, 18.75, 6, 1.5),
  "claude-3-haiku-20240307": perMillion(0.25, 1.25, 0.3, 6, 0.03),
};

/** OpenAI models, keyed as Codex writes `turn_context.model`. */
const CODEX_RATES: Readonly<Record<string, ModelRate>> = {
  "gpt-5": perMillion(1.25, 10, 0, 0, 0.125),
  "gpt-5-codex": perMillion(1.25, 10, 0, 0, 0.125),
  "gpt-5.1-codex": perMillion(1.25, 10, 0, 0, 0.125),
  "gpt-5.1-codex-max": perMillion(1.25, 10, 0, 0, 0.125),
  "gpt-5.2": perMillion(1.75, 14, 0, 0, 0.175),
  "gpt-5.2-codex": perMillion(1.75, 14, 0, 0, 0.175),
  "gpt-5.3-codex": perMillion(1.75, 14, 0, 0, 0.175),
  "gpt-5.4": perMillion(2.5, 15, 0, 0, 0.25),
  "gpt-5.4-mini": perMillion(0.75, 4.5, 0, 0, 0.075),
  "gpt-5.5": perMillion(5, 30, 0, 0, 0.5),
  "gpt-5.5-pro": perMillion(30, 180, 0, 0, 3.0),
  "gpt-5-mini": perMillion(0.25, 2, 0, 0, 0.025),
  "gpt-5-nano": perMillion(0.05, 0.4, 0, 0, 0.005),
};

/**
 * Exact-match lookup. Null means "not priced", and callers must carry that
 * through as tokens-only rather than substituting a default.
 */
export const rateFor = (provider: CliUsageProvider, model: string): ModelRate | null =>
  (provider === "claude" ? CLAUDE_RATES : CODEX_RATES)[model] ?? null;

/**
 * Every model this build can price, sorted, for the alias picker.
 *
 * Sorted here rather than at the call site so the order a user picks from is a
 * property of the table and not of whichever iteration happened to read it.
 */
export const priceableModels = (provider: CliUsageProvider): ReadonlyArray<string> =>
  Object.keys(provider === "claude" ? CLAUDE_RATES : CODEX_RATES).sort((left, right) =>
    left.localeCompare(right),
  );

/**
 * OpenAI's priority service tier bills at a multiple of the standard rate.
 *
 * Codex records the tier it ran under nowhere in the rollout, so this is read
 * once from `~/.codex/config.toml` and applied uniformly — the same
 * approximation `ccusage --speed auto` makes. It is an approximation: a machine
 * that switched tiers part-way through its history is costed at whichever tier
 * it is on now.
 */
const CODEX_FAST_MULTIPLIERS: Readonly<Record<string, number>> = {
  "gpt-5.5": 2.5,
  "gpt-5.4": 2.0,
  "gpt-5.3-codex": 2.0,
};

/** Applied to any priority-tier model the table above does not name. */
export const DEFAULT_CODEX_FAST_MULTIPLIER = 2.0;

export const codexFastMultiplier = (model: string): number =>
  CODEX_FAST_MULTIPLIERS[model] ?? DEFAULT_CODEX_FAST_MULTIPLIER;

/** Token counts for one priced message, in the shape both CLIs normalize into. */
export interface PricedTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * Cost of one message, or 0 when the model has no vendored rate.
 *
 * `multiplier` carries Codex's service tier; Claude passes 1.
 */
export const costOf = (rate: ModelRate | null, tokens: PricedTokens, multiplier = 1): number => {
  if (rate === null) return 0;
  return (
    (tokens.inputTokens * rate.input +
      tokens.outputTokens * rate.output +
      tokens.cacheWrite5mTokens * rate.cacheWrite5m +
      tokens.cacheWrite1hTokens * rate.cacheWrite1h +
      tokens.cacheReadTokens * rate.cacheRead) *
    multiplier
  );
};
