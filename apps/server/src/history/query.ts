/**
 * Terminal history - turning query strings into a page of the index.
 *
 * Pure, so the window and cursor arithmetic that decides whether paging can
 * skip or repeat a session is testable without a filesystem.
 *
 * Every parser here clamps rather than rejects. These parameters come from a
 * picker, not a human typing a URL; a nonsense `limit` should produce the
 * default page, not an error the reader has no way to act on. The one
 * exception is the session id, which is rejected outright — see
 * `HistoryIndex.resolve`.
 *
 * Only the *listing* has parameters. The preview that replaced the paginated
 * transcript route is bounded and cursorless, so the byte-offset arithmetic
 * that used to live here went with it.
 *
 * @module HistoryQuery
 */
import {
  HISTORY_SESSIONS_DEFAULT_LIMIT,
  HISTORY_SESSIONS_DEFAULT_WINDOW_DAYS,
  HISTORY_SESSIONS_MAX_LIMIT,
} from "@starcode/contracts";

import type { HistoryIndexEntry } from "./HistoryIndex.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const clampLimit = (raw: string | undefined, fallback: number, maximum: number): number => {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
};

export const clampSessionsLimit = (raw: string | undefined): number =>
  clampLimit(raw, HISTORY_SESSIONS_DEFAULT_LIMIT, HISTORY_SESSIONS_MAX_LIMIT);

/**
 * Resolves the time window.
 *
 * `since` absent means the default seven days, which is the window Michael
 * actually reads. Passing an explicit empty `since` opens the window to the
 * whole index — that is how "show older" reaches history beyond the default
 * without the client having to guess a date old enough.
 */
export const resolveWindow = (
  input: { readonly since?: string | undefined; readonly until?: string | undefined },
  nowMs: number,
): { readonly sinceMs: number | null; readonly untilMs: number | null } => {
  const parse = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    if (raw.trim().length === 0) return null;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  };
  const untilMs = parse(input.until);
  if (input.since === undefined) {
    return { sinceMs: nowMs - HISTORY_SESSIONS_DEFAULT_WINDOW_DAYS * DAY_MS, untilMs };
  }
  return { sinceMs: parse(input.since), untilMs };
};

export interface HistoryCursor {
  readonly mtimeMs: number;
  readonly id: string;
}

/** `<mtimeMs>.<id>` — the exact pair the listing sorts on, and nothing else. */
export const formatCursor = (entry: HistoryIndexEntry): string => `${entry.mtimeMs}.${entry.id}`;

/**
 * Splits on the **last** dot and parses the timestamp as a float.
 *
 * Both details are load-bearing and neither is obvious: `stat` reports
 * `mtimeMs` with sub-millisecond precision, so a real cursor looks like
 * `1784945108071.647.37e1ae…`. Splitting on the first dot would read the
 * fraction as part of the id, and `parseInt` would truncate the timestamp —
 * either one silently breaks paging at a shared mtime. Session ids are hex and
 * contain no dot, so the last one is always the separator.
 */
export const parseCursor = (raw: string | undefined): HistoryCursor | null => {
  if (raw === undefined) return null;
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const mtimeMs = Number.parseFloat(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isFinite(mtimeMs) || id.length === 0) return null;
  return { mtimeMs, id };
};

/**
 * Keeps only the entries strictly after the cursor in listing order.
 *
 * The tiebreak descends on the id, matching `compareEntries`. Without it, two
 * sessions written in the same millisecond — which happens, because Codex
 * writes several rollouts when a batch of agents starts — would either both
 * appear on both pages or neither.
 */
export const applyCursor = (
  entries: ReadonlyArray<HistoryIndexEntry>,
  cursor: HistoryCursor,
): ReadonlyArray<HistoryIndexEntry> =>
  entries.filter((entry) => {
    if (entry.mtimeMs !== cursor.mtimeMs) return entry.mtimeMs < cursor.mtimeMs;
    return entry.id.localeCompare(cursor.id) < 0;
  });

export const applyWindow = (
  entries: ReadonlyArray<HistoryIndexEntry>,
  window: { readonly sinceMs: number | null; readonly untilMs: number | null },
): ReadonlyArray<HistoryIndexEntry> =>
  entries.filter((entry) => {
    if (window.sinceMs !== null && entry.mtimeMs < window.sinceMs) return false;
    if (window.untilMs !== null && entry.mtimeMs > window.untilMs) return false;
    return true;
  });

export interface HistoryPageSelection {
  readonly page: ReadonlyArray<HistoryIndexEntry>;
  readonly nextCursor: string | null;
  readonly totalInWindow: number;
}

/**
 * Selects one page.
 *
 * `totalInWindow` counts the window *before* the cursor is applied, so it is
 * the same number on every page and the client can render a stable
 * "N sessions" without re-fetching from the start.
 */
export const selectPage = (input: {
  readonly entries: ReadonlyArray<HistoryIndexEntry>;
  readonly window: { readonly sinceMs: number | null; readonly untilMs: number | null };
  readonly cursor: HistoryCursor | null;
  readonly limit: number;
}): HistoryPageSelection => {
  const inWindow = applyWindow(input.entries, input.window);
  const afterCursor = input.cursor === null ? inWindow : applyCursor(inWindow, input.cursor);
  const page = afterCursor.slice(0, input.limit);
  const last = page.at(-1);
  const hasMore = afterCursor.length > page.length;
  return {
    page,
    nextCursor: hasMore && last !== undefined ? formatCursor(last) : null,
    totalInWindow: inWindow.length,
  };
};
