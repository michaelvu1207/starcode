/**
 * Terminal history - enough of a session to recognise it.
 *
 * The question this answers is narrow and it is the only question left now
 * that history is import-only: *which conversation is this?* Titles sometimes
 * lie, and two sessions in the same repo on the same day look identical in a
 * list. What separates them is how each one opened and where it ended up — so
 * a preview is the first thing a human typed plus the last few exchanges, read
 * from opposite ends of the file, with the middle deliberately never fetched.
 *
 * There is no cursor and no "load earlier". The paginated reader this replaced
 * had both, and keeping them would have meant carrying byte-offset arithmetic
 * and a client paging loop for a surface nobody is allowed to scroll.
 *
 * @module HistoryPreview
 */
import {
  HISTORY_PREVIEW_TAIL_ENTRIES,
  type HistoryProvider,
  type HistoryTranscriptEntry,
} from "@starcode/contracts";

import { readSessionOpening, readSessionTail } from "./tailReader.ts";

export interface SessionPreview {
  /**
   * The session's first human turn. Null when the tail already contains it —
   * a short session is shown whole rather than with its opening duplicated —
   * or when the head read found no human turn at all.
   */
  readonly opening: HistoryTranscriptEntry | null;
  readonly tail: ReadonlyArray<HistoryTranscriptEntry>;
  /** True when entries sit between `opening` and the start of `tail`. */
  readonly gap: boolean;
}

export const readSessionPreview = async (input: {
  readonly path: string;
  readonly provider: HistoryProvider;
  readonly tailEntries?: number;
}): Promise<SessionPreview> => {
  const limit = input.tailEntries ?? HISTORY_PREVIEW_TAIL_ENTRIES;
  const [opening, tail] = await Promise.all([
    readSessionOpening({ path: input.path, provider: input.provider }),
    readSessionTail({ path: input.path, provider: input.provider, limit }),
  ]);

  const firstTailOffset = tail.entries[0]?.offset;
  if (opening === null || firstTailOffset === undefined) {
    return { opening, tail: tail.entries, gap: false };
  }
  // The two reads overlap on any session short enough that its opening is
  // still within the last few entries. Reporting it twice would make a
  // four-message session look like five.
  if (opening.offset >= firstTailOffset) {
    return { opening: null, tail: tail.entries, gap: false };
  }
  // `oldestExamined` is where the backwards scan stopped. Anything above the
  // opening and below that point is history this endpoint will never fetch,
  // and saying so is the difference between "a nine-message session" and
  // "nine of four hundred".
  return { opening, tail: tail.entries, gap: tail.oldestExamined > opening.offset };
};
