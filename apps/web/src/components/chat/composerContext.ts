/**
 * Fork-owned: the composer's single context row.
 *
 * Two different numbers used to be on screen at once — the model's context
 * window (a per-thread selector, "200k" / "1M") and the instance's compaction
 * cap (a Claude Code setting, "600k") — sitting in adjacent rows of the same
 * popover and reading as a contradiction. They are not the same claim, but
 * only one of them is the point: Claude compacts at whichever is lower.
 *
 * So the popover keeps one context row. Its control is the window selector
 * where the model has one, and this module writes the line underneath that
 * states where the conversation will actually compact.
 *
 * @module composerContext
 */
import {
  formatClaudeContextLimitLabel,
  parseClaudeContextLimitTokens,
} from "@t3tools/shared/claudeContextLimit";

export interface ComposerContextRowInput {
  /** Whether the selected model exposes a `contextWindow` option to pick from. */
  readonly hasWindowSelector: boolean;
  /** Resolved `contextWindow` selection ("200k", "1m"), or null when absent. */
  readonly windowValue: string | null;
  /** Compaction cap the server will enforce; null for drivers without one. */
  readonly capTokens: number | null;
}

export interface ComposerContextRow {
  /**
   * Read-only value for models that expose no selector — without one there is
   * nothing to choose, so the row still has to say something.
   */
  readonly chipLabel: string | null;
  /** Sub-label under "Context". Empty when we cannot claim a compaction point. */
  readonly hint: string;
}

/**
 * Build the row, or `null` when this provider has nothing to say about context
 * (no window selector and no cap — every Codex model, for instance).
 */
export function buildComposerContextRow(input: ComposerContextRowInput): ComposerContextRow | null {
  const { hasWindowSelector, windowValue, capTokens } = input;
  if (!hasWindowSelector && capTokens === null) {
    return null;
  }

  const windowTokens = parseClaudeContextLimitTokens(windowValue);
  const chipLabel =
    hasWindowSelector || capTokens === null ? null : formatClaudeContextLimitLabel(capTokens);

  // The cap only binds when it is below the window. A 200k model on a 600k cap
  // compacts at 200k, and saying "600k" there would be wrong.
  if (capTokens !== null && (windowTokens === null || capTokens < windowTokens)) {
    return {
      chipLabel,
      hint: `Compacts near ${formatClaudeContextLimitLabel(capTokens)}. Change in Settings.`,
    };
  }
  if (capTokens !== null && windowTokens !== null) {
    return { chipLabel, hint: `Compacts near ${formatClaudeContextLimitLabel(windowTokens)}.` };
  }
  return { chipLabel, hint: "" };
}
