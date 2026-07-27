/**
 * Fork-owned: Claude context policy — one number, chosen per thread.
 *
 * A Claude thread's context is really two settings that have to agree. The
 * model id picks the API window (`claude-fable-5` is 200k; `claude-fable-5[1m]`
 * is 1M), and `autoCompactWindow` — a Claude Code setting, session-scoped when
 * passed via `--settings`, which the Agent SDK does for us — decides where
 * inside that window the transcript gets summarized: the CLI compacts once it
 * reaches `min(nativeWindow, autoCompactWindow) - reservedOutput - headroom`.
 *
 * The fork used to expose both, and they read as a contradiction: a thread
 * could say "1M" in the model row and "600k" in the row under it. So the two
 * are collapsed into one user-facing choice — 200k, 600k, or 1M — and the pair
 * is derived from it. The choice is the effective context; nothing else caps it.
 *
 * The CLI validates `autoCompactWindow` as an integer in [100_000, 1_000_000]
 * and silently drops anything outside that band, so we clamp rather than
 * letting a typo disable compaction. It also refuses to auto-compact at all
 * below 200_000, which is why the smallest choice is 200k.
 *
 * This is a compaction threshold, not a wall: a single oversized tool result
 * can still overshoot within one turn, because the check runs between turns.
 *
 * @module claudeContextLimit
 */

/**
 * The context sizes a thread may be set to, smallest first. Every model offers
 * a prefix of this list — the ones with no 1M window offer only the first.
 */
export const CLAUDE_CONTEXT_CHOICES = ["200k", "600k", "1m"] as const;
export type ClaudeContextChoice = (typeof CLAUDE_CONTEXT_CHOICES)[number];

/** Descriptor id of the one context control the composer renders for Claude. */
export const CLAUDE_CONTEXT_OPTION_ID = "context";

const CLAUDE_CONTEXT_CHOICE_TOKENS: Record<ClaudeContextChoice, number> = {
  "200k": 200_000,
  "600k": 600_000,
  "1m": 1_000_000,
};

const CLAUDE_CONTEXT_CHOICE_LABELS: Record<ClaudeContextChoice, string> = {
  "200k": "200k",
  "600k": "600k",
  "1m": "1M",
};

/** Token budget a choice stands for — the `autoCompactWindow` we hand the CLI. */
export function claudeContextChoiceTokens(choice: ClaudeContextChoice): number {
  return CLAUDE_CONTEXT_CHOICE_TOKENS[choice];
}

/** Menu label for a choice ("1m" reads as "1M"). */
export function claudeContextChoiceLabel(choice: ClaudeContextChoice): string {
  return CLAUDE_CONTEXT_CHOICE_LABELS[choice];
}

export function isClaudeContextChoice(
  value: string | null | undefined,
): value is ClaudeContextChoice {
  return CLAUDE_CONTEXT_CHOICES.some((choice) => choice === value);
}

/**
 * Fit a token budget onto the choices a model actually offers, clamping down
 * rather than up: a 600k default on a model that only reaches 200k becomes
 * 200k, never 1M. `offered` is assumed non-empty and in ascending order.
 */
export function clampToClaudeContextChoice(
  tokens: number,
  offered: ReadonlyArray<ClaudeContextChoice>,
): ClaudeContextChoice {
  let fitted = offered[0] as ClaudeContextChoice;
  for (const choice of offered) {
    if (CLAUDE_CONTEXT_CHOICE_TOKENS[choice] <= tokens) {
      fitted = choice;
    }
  }
  return fitted;
}

/** Default cap applied to every Claude instance that has not overridden it. */
export const DEFAULT_CLAUDE_CONTEXT_LIMIT_TOKENS = 600_000;

/**
 * Below this the Claude CLI stops auto-compacting entirely (its own
 * `window < 200_000` guard), so a smaller value would silently mean "no cap".
 */
export const MIN_CLAUDE_CONTEXT_LIMIT_TOKENS = 200_000;

/** Upper bound accepted by the CLI's settings schema. */
export const MAX_CLAUDE_CONTEXT_LIMIT_TOKENS = 1_000_000;

/**
 * Parse a persisted context-limit setting into the token count handed to
 * Claude Code. Blank, malformed, and out-of-band values fall back to (or
 * clamp toward) the default rather than disabling the cap.
 *
 * Accepts a bare token count (`"600000"`) or a `k`/`m` shorthand (`"600k"`,
 * `"1m"`) so the value stays readable in the provider settings form.
 */
export function resolveClaudeContextLimitTokens(raw: string | null | undefined): number {
  const parsed = parseClaudeContextLimitTokens(raw);
  if (parsed === null) {
    return DEFAULT_CLAUDE_CONTEXT_LIMIT_TOKENS;
  }
  return Math.min(
    MAX_CLAUDE_CONTEXT_LIMIT_TOKENS,
    Math.max(MIN_CLAUDE_CONTEXT_LIMIT_TOKENS, parsed),
  );
}

/**
 * The instance's configured starting context, or `null` when it has none.
 *
 * Distinct from {@link resolveClaudeContextLimitTokens}, which owes its caller
 * a number: here "unset" has to survive, because an instance that has not
 * chosen a default leaves each model on its own usual starting size rather
 * than being pulled to a single one.
 */
export function resolveClaudeInstanceContextDefault(raw: string | null | undefined): number | null {
  const parsed = parseClaudeContextLimitTokens(raw);
  if (parsed === null) {
    return null;
  }
  return Math.min(
    MAX_CLAUDE_CONTEXT_LIMIT_TOKENS,
    Math.max(MIN_CLAUDE_CONTEXT_LIMIT_TOKENS, parsed),
  );
}

/**
 * Strict parse used by {@link resolveClaudeContextLimitTokens} and by the
 * settings form's validation hint. Returns `null` when the input carries no
 * usable number; the caller decides whether that means "default" or "invalid".
 */
export function parseClaudeContextLimitTokens(raw: string | null | undefined): number | null {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return null;
  }
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(magnitude * multiplier);
}

/** Compact label for the composer summary and the popover row ("600k", "1M"). */
export function formatClaudeContextLimitLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens % 1_000 === 0) {
    return `${tokens / 1_000}k`;
  }
  return tokens.toLocaleString("en-US");
}
