/**
 * Fork-owned: the composer's single context row.
 *
 * Two different numbers used to be on screen at once — the model's context
 * window (a per-thread selector, "200k" / "1M") and the instance's compaction
 * cap (a Claude Code setting, "600k") — sitting in adjacent rows of the same
 * popover and reading as a contradiction. They were never the same claim, and
 * the one the user could see was not the one that bound.
 *
 * So there is one concept now, chosen per thread beside the model: Context,
 * one of 200k / 600k / 1M. The server derives the API window and the
 * compaction point from it (see `@starcode/shared/claudeContextLimit`), and
 * nothing else caps what the user picked. This module decides only what the
 * row shows when the model offers no choice to make.
 *
 * @module composerContext
 */
import { formatClaudeContextLimitLabel } from "@starcode/shared/claudeContextLimit";

export interface ComposerContextRowInput {
  /** Whether the selected model exposes a context option to pick from. */
  readonly hasSelector: boolean;
  /**
   * Context this thread gets when the model offers no choice — the instance
   * default. Null for providers that make no context claim at all (Codex).
   */
  readonly fallbackTokens: number | null;
}

export interface ComposerContextRow {
  /**
   * Read-only value for models that expose no selector — without one there is
   * nothing to choose, so the row still has to say something.
   */
  readonly chipLabel: string | null;
  /** Sub-label under "Context". Empty when the selector speaks for itself. */
  readonly hint: string;
}

/**
 * Build the row, or `null` when this provider has nothing to say about context
 * (no selector and no default — every Codex model, for instance).
 */
export function buildComposerContextRow(input: ComposerContextRowInput): ComposerContextRow | null {
  const { hasSelector, fallbackTokens } = input;
  if (hasSelector) {
    return { chipLabel: null, hint: "" };
  }
  if (fallbackTokens === null) {
    return null;
  }
  return {
    chipLabel: formatClaudeContextLimitLabel(fallbackTokens),
    hint: "This model offers no choice. Change the default in Settings.",
  };
}
