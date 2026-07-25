import type {
  HistorySessionSummary,
  HistoryTranscriptEntry,
  HistoryTranscriptPage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  foldTranscriptPages,
  formatSessionSize,
  shouldAutoContinue,
} from "./HistoryTranscript.logic";

const SESSION: HistorySessionSummary = {
  id: "0123456789abcdef0123456789abcdef" as HistorySessionSummary["id"],
  provider: "claude",
  projectPath: "/w/app",
  projectLabel: "app",
  snippet: "do the thing",
  lastActivityAt: "2026-07-24T10:00:00.000Z",
  sizeBytes: 39_405_681,
};

const entry = (offset: number, text: string): HistoryTranscriptEntry => ({
  offset,
  role: "user",
  text,
  truncated: false,
  toolCalls: [],
  timestamp: null,
});

const page = (input: {
  readonly entries: ReadonlyArray<HistoryTranscriptEntry>;
  readonly hasMore?: boolean;
  readonly nextBefore?: number | null;
}): HistoryTranscriptPage => ({
  session: SESSION,
  entries: input.entries,
  hasMore: input.hasMore ?? false,
  nextBefore: input.nextBefore ?? null,
});

describe("foldTranscriptPages", () => {
  it("puts backwards-fetched pages into reading order", () => {
    // Page 0 is the tail, page 1 is older. The result must read oldest-first.
    const state = foldTranscriptPages([
      page({
        entries: [entry(300, "third"), entry(400, "fourth")],
        hasMore: true,
        nextBefore: 300,
      }),
      page({
        entries: [entry(100, "first"), entry(200, "second")],
        hasMore: true,
        nextBefore: 100,
      }),
    ]);
    expect(state.rows.map((row) => row.entry.text)).toEqual(["first", "second", "third", "fourth"]);
  });

  it("orders by offset even when a page resolves out of turn", () => {
    // Every page is its own atom, so arrival order is not request order.
    const state = foldTranscriptPages([
      page({ entries: [entry(100, "first")], hasMore: true, nextBefore: 100 }),
      page({ entries: [entry(300, "third")] }),
    ]);
    expect(state.rows.map((row) => row.entry.offset)).toEqual([100, 300]);
  });

  it("deduplicates an entry served by two overlapping pages", () => {
    const state = foldTranscriptPages([
      page({ entries: [entry(100, "a"), entry(200, "b")] }),
      page({ entries: [entry(200, "b"), entry(300, "c")] }),
    ]);
    expect(state.rows).toHaveLength(3);
  });

  it("takes hasMore from the oldest page, not the newest", () => {
    const state = foldTranscriptPages([
      page({ entries: [entry(400, "newest")], hasMore: true, nextBefore: 400 }),
      page({ entries: [entry(100, "oldest")], hasMore: false, nextBefore: null }),
    ]);
    expect(state.hasMore).toBe(false);
    expect(state.nextBefore).toBeNull();
  });

  it("carries the session from the first page", () => {
    expect(foldTranscriptPages([page({ entries: [] })]).session).toEqual(SESSION);
    expect(foldTranscriptPages([]).session).toBeNull();
  });
});

describe("shouldAutoContinue", () => {
  const empty = foldTranscriptPages([page({ entries: [], hasMore: true, nextBefore: 5_000 })]);

  it("follows an empty page so the viewer never opens blank", () => {
    // A session can end with a long run of records that render to nothing;
    // the local store has one whose last 204 MB is image data.
    expect(shouldAutoContinue({ pending: false, pageCount: 1, state: empty })).toBe(true);
  });

  it("stops once anything has rendered", () => {
    const withRows = foldTranscriptPages([
      page({ entries: [entry(100, "a")], hasMore: true, nextBefore: 100 }),
    ]);
    expect(shouldAutoContinue({ pending: false, pageCount: 1, state: withRows })).toBe(false);
  });

  it("does not stack requests while one is in flight", () => {
    expect(shouldAutoContinue({ pending: true, pageCount: 1, state: empty })).toBe(false);
  });

  it("gives up after a bounded number of hops", () => {
    // Following indefinitely would turn one click into hundreds of megabytes.
    expect(shouldAutoContinue({ pending: false, pageCount: 6, state: empty })).toBe(false);
  });

  it("stops at the front of the file", () => {
    const done = foldTranscriptPages([page({ entries: [], hasMore: false, nextBefore: null })]);
    expect(shouldAutoContinue({ pending: false, pageCount: 1, state: done })).toBe(false);
  });
});

describe("formatSessionSize", () => {
  it("uses the units a reader thinks in", () => {
    expect(formatSessionSize(512)).toEqual("512 B");
    expect(formatSessionSize(4_096)).toEqual("4 KB");
    expect(formatSessionSize(1_500_000)).toEqual("1.4 MB");
    expect(formatSessionSize(39_405_681)).toEqual("38 MB");
  });
});
