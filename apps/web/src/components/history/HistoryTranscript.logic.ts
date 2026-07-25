/**
 * Transcript viewer logic.
 *
 * Pure, and split out because the interesting parts — folding backwards pages
 * into one ascending list, and deciding when an empty page should be followed
 * automatically — are exactly the parts worth asserting without a DOM.
 */
import type { HistorySessionSummary, HistoryTranscriptPage } from "@t3tools/contracts";
import type { HistoryTranscriptEntry } from "@t3tools/contracts";

/** Entries per request. Matches the server's default. */
export const HISTORY_TRANSCRIPT_PAGE_SIZE = 80;

/**
 * Pages one viewer will hold. A preview, not an archive: past this the reader
 * is told the limit was reached rather than being allowed to walk a 600 MB
 * session into the browser's memory.
 */
export const MAX_TRANSCRIPT_PAGES = 12;

/**
 * How many empty pages in a row to follow before giving up and letting the
 * reader decide.
 *
 * A session can legitimately end with a long run of records that render to
 * nothing — the local store has one whose last 204 MB is image data. Following
 * a few pages automatically turns that from an empty pane into a brief load;
 * following it indefinitely would turn one click into a hundred megabytes.
 */
const AUTO_CONTINUE_PAGE_LIMIT = 6;

export interface TranscriptRow {
  readonly id: string;
  readonly entry: HistoryTranscriptEntry;
}

export interface TranscriptState {
  /** Ascending by offset: oldest first, newest at the bottom. */
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly session: HistorySessionSummary | null;
  readonly hasMore: boolean;
  readonly nextBefore: number | null;
}

/**
 * Folds pages fetched backwards into one ascending list.
 *
 * Pages arrive newest-first (page 0 is the tail, page 1 is older, and so on),
 * and each page's own entries are already ascending. Sorting by offset rather
 * than trusting arrival order means a page that resolves out of turn — which
 * happens, since every page is its own atom — cannot scramble the transcript.
 */
export function foldTranscriptPages(pages: ReadonlyArray<HistoryTranscriptPage>): TranscriptState {
  const byOffset = new Map<number, HistoryTranscriptEntry>();
  for (const page of pages) {
    for (const entry of page.entries) byOffset.set(entry.offset, entry);
  }
  const rows = [...byOffset.values()]
    .sort((left, right) => left.offset - right.offset)
    .map((entry) => ({ id: String(entry.offset), entry }));

  // The oldest page decides whether anything earlier remains, and it is the
  // one that reached furthest back - not necessarily the last to arrive.
  //
  // A null cursor ranks oldest, not newest: it means that page reached the
  // front of the file, which is as far back as any page can get.
  const reach = (page: HistoryTranscriptPage): number =>
    page.nextBefore ?? Number.NEGATIVE_INFINITY;
  const oldest = pages.reduce<HistoryTranscriptPage | null>(
    (best, page) => (best === null || reach(page) < reach(best) ? page : best),
    null,
  );

  return {
    rows,
    session: pages[0]?.session ?? null,
    hasMore: oldest?.hasMore ?? false,
    nextBefore: oldest?.nextBefore ?? null,
  };
}

/**
 * Whether the viewer should fetch the next page without being asked.
 *
 * Only while it has nothing to show. Once a single entry has rendered, further
 * paging is the reader's decision.
 */
export function shouldAutoContinue(input: {
  readonly pending: boolean;
  readonly pageCount: number;
  readonly state: TranscriptState;
}): boolean {
  if (input.pending) return false;
  if (input.state.rows.length > 0) return false;
  if (!input.state.hasMore || input.state.nextBefore === null) return false;
  return input.pageCount < AUTO_CONTINUE_PAGE_LIMIT;
}

/** File size for the viewer header, in the units a reader thinks in. */
export function formatSessionSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  const megabytes = bytes / (1_024 * 1_024);
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}
