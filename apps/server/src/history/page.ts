/**
 * Terminal history - one page of a session, read backwards.
 *
 * The preview answers *which conversation is this?*. This answers the question
 * an imported thread raises and the preview deliberately does not: *what was
 * actually said before I got here?* — for a thread whose model remembers every
 * word of a conversation the view shows none of.
 *
 * It is not the history viewer F12 deleted coming back. That viewer was a
 * destination: its own route, its own sidebar strip, reachable for any session
 * on any machine. This is a section inside one thread, scoped to the one
 * session that thread resumes, and it exists because the alternative is a
 * transcript that starts mid-conversation with no way to see the rest.
 *
 * **Newest page first, then earlier on request.** These sessions run past 38 MB
 * and one on this machine reaches 638 MB, so there is no version of "load the
 * transcript" that is acceptable at thread-open time. A page is the last N
 * renderable entries below a byte cursor, which costs a few hundred KB no
 * matter how large the file is, and `nextBefore` walks the file backwards from
 * there.
 *
 * @module HistoryPage
 */
import {
  HISTORY_PAGE_DEFAULT_ENTRIES,
  HISTORY_PAGE_MAX_ENTRIES,
  type HistoryProvider,
  type HistoryTranscriptEntry,
} from "@t3tools/contracts";

import { readSessionTail } from "./tailReader.ts";

export interface SessionPage {
  /** Ascending by offset: oldest first, newest last, the order a thread reads in. */
  readonly entries: ReadonlyArray<HistoryTranscriptEntry>;
  /**
   * Byte cursor for the page immediately earlier, or null when this page
   * reached the top of the file.
   *
   * It is the oldest offset *examined* rather than the oldest entry returned,
   * so a run of records that render to nothing — tool results, images, a
   * Codex rollout's 204 MB of attachments — is walked past once instead of
   * re-scanned on every subsequent page.
   */
  readonly nextBefore: number | null;
}

/**
 * Clamps a caller's page size.
 *
 * Arrives as a query string, so a garbled value clamps to the default rather
 * than failing the request — the same contract the sessions listing's limit
 * has, for the same reason.
 */
export const clampPageEntries = (raw: string | undefined): number => {
  if (raw === undefined) return HISTORY_PAGE_DEFAULT_ENTRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return HISTORY_PAGE_DEFAULT_ENTRIES;
  return Math.min(parsed, HISTORY_PAGE_MAX_ENTRIES);
};

/**
 * Parses a byte cursor.
 *
 * Null for anything that is not a non-negative integer, which the caller reads
 * as "start at the end of the file". A cursor is only ever a value this module
 * minted, so a malformed one is a stale link or a hand-edited URL, and serving
 * the newest page is a better answer than an error.
 */
export const parsePageCursor = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const readSessionPage = async (input: {
  readonly path: string;
  readonly provider: HistoryProvider;
  /** Exclusive byte ceiling. Absent, the page is the end of the file. */
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
  readonly chunkBytes?: number | undefined;
  readonly maxPageBytes?: number | undefined;
  readonly hardMaxPageBytes?: number | undefined;
}): Promise<SessionPage> => {
  const tail = await readSessionTail({
    path: input.path,
    provider: input.provider,
    limit: input.limit ?? HISTORY_PAGE_DEFAULT_ENTRIES,
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.chunkBytes === undefined ? {} : { chunkBytes: input.chunkBytes }),
    ...(input.maxPageBytes === undefined ? {} : { maxPageBytes: input.maxPageBytes }),
    ...(input.hardMaxPageBytes === undefined ? {} : { hardMaxPageBytes: input.hardMaxPageBytes }),
  });
  // The `< ceiling` half is the anti-stall guard, not a formality. A cursor
  // that came back equal to the one sent would leave "show earlier" fetching
  // the same page forever, and the reader has one escape — a record longer
  // than the whole byte budget — that steps the cursor to a chunk boundary
  // rather than to a line. Refusing a cursor that did not move turns that into
  // a page that says the conversation ends here, which is wrong but finite.
  const ceiling = input.before ?? Number.POSITIVE_INFINITY;
  const nextBefore =
    tail.oldestExamined > 0 && tail.oldestExamined < ceiling ? tail.oldestExamined : null;
  return { entries: tail.entries, nextBefore };
};
