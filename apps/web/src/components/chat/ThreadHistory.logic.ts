/**
 * Where a thread's conversation came from, and how to walk back through it.
 *
 * An imported or forked thread opens with an empty transcript that the model
 * nonetheless remembers every word of. F12 defused the surprise with a line of
 * text; this defuses it with the conversation itself, on request. The pure
 * parts of that live here: which provenance a thread has, what the collapsed
 * summary says, and which page cursors have been asked for.
 *
 * The paging state is the part worth reading carefully. It is a list of byte
 * cursors rather than an accumulated list of entries, because each page is its
 * own cached atom — so collapsing the section and reopening it re-renders what
 * was already read instead of re-fetching it, and a page that arrived once
 * never arrives twice.
 */
import type {
  HistoryForkRecord,
  HistoryForkProvider,
  HistoryImportRecord,
  HistoryProvider,
  HistorySessionId,
  ThreadId,
} from "@starcode/contracts";

import { formatShortDate } from "../history/ImportConversationDialog.logic";
import { historyProviderLabel } from "../sidebar/HistoryProviderIcon";

/**
 * The two ways a thread inherits a conversation.
 *
 * A discriminated union rather than one nullable-everything record, because
 * the sentence each produces is different — "resumed from a Claude Code
 * terminal session" versus "forked from another thread" — and a caller
 * reconstructing which it held from which fields happened to be null would get
 * it wrong on exactly the rows where it matters.
 */
export type ThreadProvenance =
  | { readonly kind: "imported"; readonly record: HistoryImportRecord }
  | { readonly kind: "forked"; readonly record: HistoryForkRecord };

/**
 * Which CLI session or source thread, if any, a thread inherited from.
 *
 * Null covers three different states that all render the same way — no
 * provenance, still loading, and a machine whose server cannot say — because
 * the alternative to "say nothing" is asserting a thread is ordinary when it
 * may not be.
 */
export function resolveThreadProvenance(input: {
  readonly imports: ReadonlyArray<HistoryImportRecord> | null;
  readonly forks: ReadonlyArray<HistoryForkRecord> | null;
  readonly threadId: ThreadId | null;
}): ThreadProvenance | null {
  if (input.threadId === null) return null;
  const imported = input.imports?.find((record) => record.threadId === input.threadId);
  if (imported !== undefined) return { kind: "imported", record: imported };
  const forked = input.forks?.find((record) => record.threadId === input.threadId);
  if (forked !== undefined) return { kind: "forked", record: forked };
  return null;
}

/** Everything the section needs, flattened out of whichever record it came from. */
export interface ThreadHistoryModel {
  readonly provider: HistoryProvider | HistoryForkProvider;
  /**
   * The session to read, or null when this machine cannot address one — a fork
   * whose source file the index never found, or an import registry row written
   * before this field existed. The summary still renders; only the disclosure
   * does not.
   */
  readonly sessionId: HistorySessionId | null;
  /**
   * Byte ceiling for the first page: where the session stood when this thread
   * took it over. Null falls back to the end of the file, which is right until
   * the thread takes a turn of its own and appends to it.
   */
  readonly before: number | null;
  /** The one line shown when the section is collapsed. */
  readonly summary: string;
}

/**
 * The collapsed summary: how much conversation is behind this thread, when it
 * happened, and where it came from.
 *
 * Every part is omitted rather than guessed at when it is unknown. A message
 * count is null whenever the server's scan hit its byte budget, a date range
 * needs at least one timestamp, and a machine label is absent on a thread
 * whose connection has not resolved — and a summary that invented any of them
 * would be least trustworthy on exactly the long sessions this is for.
 */
export function buildThreadHistoryModel(input: {
  readonly provenance: ThreadProvenance;
  readonly machineLabel: string | null;
}): ThreadHistoryModel {
  const { provenance } = input;
  const record = provenance.record;
  const parts: string[] = [];

  const messageCount = provenance.kind === "imported" ? provenance.record.messageCount : null;
  if (messageCount !== null) {
    parts.push(`${messageCount.toLocaleString()} ${messageCount === 1 ? "message" : "messages"}`);
  }

  const range = formatDateRange(record.startedAt, record.lastActivityAt ?? null);
  if (range !== null) parts.push(range);

  parts.push(
    provenance.kind === "imported"
      ? withMachine(`from ${historyProviderLabel(record.provider)}`, input.machineLabel)
      : formatForkOrigin(provenance.record.sourceTitle),
  );

  return {
    provider: record.provider,
    // Non-null on an import (the id is how the session was chosen) and
    // nullable on a fork (the session id had to be matched back to a file),
    // which the union collapses to the honest weaker type.
    sessionId: record.historySessionId,
    before: record.sourceSizeBytes ?? null,
    summary: parts.join(" · "),
  };
}

const withMachine = (sentence: string, machineLabel: string | null): string =>
  machineLabel === null || machineLabel.trim().length === 0
    ? sentence
    : `${sentence} on ${machineLabel.trim()}`;

/**
 * Names the source thread when it had a name.
 *
 * The machine is left out on purpose: a fork always lives on the machine its
 * source does, so naming it would be noise on the one provenance that cannot
 * cross machines.
 */
const formatForkOrigin = (sourceTitle: string | null): string =>
  sourceTitle === null || sourceTitle.trim().length === 0
    ? "forked from another thread"
    : `forked from ${sourceTitle.trim()}`;

/**
 * `Jul 12 – Jul 26`, or one date when both fall on the same day.
 *
 * A single-day session showing "Jul 12 – Jul 12" reads as a formatting bug, and
 * a range is only worth printing when it says something the first date did not.
 */
export function formatDateRange(startedAt: string | null, endedAt: string | null): string | null {
  const start = startedAt === null ? "" : formatShortDate(startedAt);
  const end = endedAt === null ? "" : formatShortDate(endedAt);
  if (start.length === 0 && end.length === 0) return null;
  if (start.length === 0) return end;
  if (end.length === 0 || start === end) return start;
  return `${start} – ${end}`;
}

/**
 * Which pages of a session have been rendered, and what lies behind the oldest.
 *
 * The split between `cursors` and `pendingBefore` is the whole design. A page
 * is fetched by being rendered, so a cursor that lands in `cursors` is a
 * request — which means the answer the oldest page gave about what precedes it
 * has to be held *outside* that list until somebody actually asks for it.
 * Merging the two would turn every page into a prefetch of the next, and
 * "lazy" would quietly mean "walks the whole session one page behind you".
 *
 * `null` as a cursor means "the end of the file", which is what the first page
 * gets when no boundary was recorded for the thread.
 */
export interface HistoryPagingState {
  /** Newest page first. Rendering walks it in reverse, so the oldest is on top. */
  readonly cursors: ReadonlyArray<number | null>;
  /**
   * What the oldest rendered page said precedes it: a byte cursor, or
   * `undefined` while that page has not answered yet. Never null — a page that
   * reached the top of the session sets `exhausted` instead, because "nothing
   * earlier" and "not asked yet" must not share a value.
   */
  readonly pendingBefore: number | undefined;
  /** True once the top of the session was reached, which retires "show earlier". */
  readonly exhausted: boolean;
}

export const initialHistoryPaging = (before: number | null): HistoryPagingState => ({
  cursors: [before],
  pendingBefore: undefined,
  exhausted: false,
});

/**
 * Records what the oldest rendered page said lies behind it.
 *
 * Nothing is fetched as a result: this only makes "show earlier" offerable.
 */
export function reportOldestPage(
  state: HistoryPagingState,
  nextBefore: number | null,
): HistoryPagingState {
  if (state.exhausted) return state;
  if (nextBefore === null) {
    return { cursors: state.cursors, pendingBefore: undefined, exhausted: true };
  }
  return { cursors: state.cursors, pendingBefore: nextBefore, exhausted: false };
}

/**
 * Renders one more page, older than everything already shown.
 *
 * The `includes` check is the anti-stall guard, and it is not defensive
 * boilerplate: the server's backwards reader has one escape hatch — a record
 * longer than an entire page budget — that hands back a cursor which does not
 * advance. Without this, "show earlier" would fetch the same page for as long
 * as somebody kept clicking, each time appearing to do nothing.
 */
export function loadEarlierHistoryPage(state: HistoryPagingState): HistoryPagingState {
  if (state.exhausted || state.pendingBefore === undefined) return state;
  if (state.cursors.includes(state.pendingBefore)) {
    return { cursors: state.cursors, pendingBefore: undefined, exhausted: true };
  }
  return {
    cursors: [...state.cursors, state.pendingBefore],
    pendingBefore: undefined,
    exhausted: false,
  };
}

/** Whether there is a page to offer, and an answer about it to act on. */
export function canLoadEarlier(state: HistoryPagingState): boolean {
  return !state.exhausted && state.pendingBefore !== undefined;
}

/** Index of the page currently at the top, which is the only one that reports. */
export function oldestCursorIndex(state: HistoryPagingState): number {
  return state.cursors.length - 1;
}
