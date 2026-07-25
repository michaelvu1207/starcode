/**
 * Fork-owned: Claude context-limit policy.
 *
 * Claude Code exposes no hard cap on the context window it will fill. The
 * only knob that bounds it is `autoCompactWindow` — a Claude Code setting
 * (session-scoped when passed via `--settings`, which the Agent SDK does for
 * us) that the CLI treats as the effective window for its auto-compaction
 * arithmetic: it compacts once the transcript reaches
 * `min(nativeWindow, autoCompactWindow) - reservedOutput - headroom`.
 *
 * The CLI validates the value as an integer in [100_000, 1_000_000] and
 * silently drops anything outside that band, so we clamp here rather than
 * letting a typo disable the cap. It also refuses to auto-compact at all when
 * the resolved window falls below 200_000, so that is our real floor.
 *
 * This is a compaction threshold, not a wall: a single oversized tool result
 * can still overshoot within one turn, because the check runs between turns.
 *
 * @module claudeContextLimit
 */

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
