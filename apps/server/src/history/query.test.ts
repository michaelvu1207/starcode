import { describe, expect, it } from "@effect/vitest";
import type { HistorySessionId } from "@starcode/contracts";

import type { HistoryIndexEntry } from "./HistoryIndex.ts";
import {
  applyCursor,
  clampSessionsLimit,
  formatCursor,
  parseCursor,
  resolveWindow,
  selectPage,
} from "./query.ts";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;

const entry = (id: string, mtimeMs: number): HistoryIndexEntry => ({
  kind: "session",
  id: id as HistorySessionId,
  provider: "claude",
  path: `/store/${id}.jsonl`,
  pathDerivedProject: "/w",
  mtimeMs,
  sizeBytes: 100,
});

/** Newest first, id descending on a tie - the order the index maintains. */
const entries: ReadonlyArray<HistoryIndexEntry> = [
  entry("ff", NOW - 1 * DAY),
  entry("ee", NOW - 2 * DAY),
  entry("dd", NOW - 2 * DAY), // deliberate mtime tie with "ee"
  entry("cc", NOW - 6 * DAY),
  entry("bb", NOW - 30 * DAY),
  entry("aa", NOW - 90 * DAY),
];

describe("clampLimit", () => {
  it("defaults, clamps, and never rejects", () => {
    expect(clampSessionsLimit(undefined)).toEqual(40);
    expect(clampSessionsLimit("10")).toEqual(10);
    expect(clampSessionsLimit("100000")).toEqual(200);
    // A garbled limit from a stale client is the default page, not a 400 the
    // sidebar strip has no way to act on.
    expect(clampSessionsLimit("banana")).toEqual(40);
    expect(clampSessionsLimit("-5")).toEqual(40);
    expect(clampSessionsLimit("0")).toEqual(40);
  });
});

describe("resolveWindow", () => {
  it("defaults to the last seven days", () => {
    expect(resolveWindow({}, NOW).sinceMs).toEqual(NOW - 7 * DAY);
  });

  it("opens the window to the whole index when since is explicitly empty", () => {
    // This is how "show older" reaches past the default without the client
    // having to guess a date old enough.
    expect(resolveWindow({ since: "" }, NOW).sinceMs).toBeNull();
  });

  it("accepts an explicit bound and ignores an unparseable one", () => {
    expect(resolveWindow({ since: "2026-07-01T00:00:00.000Z" }, NOW).sinceMs).toEqual(
      Date.parse("2026-07-01T00:00:00.000Z"),
    );
    expect(resolveWindow({ since: "not a date" }, NOW).sinceMs).toBeNull();
    expect(resolveWindow({ until: "2026-07-20T00:00:00.000Z" }, NOW).untilMs).toEqual(
      Date.parse("2026-07-20T00:00:00.000Z"),
    );
  });
});

describe("cursor round-trip", () => {
  it("parses what it formats", () => {
    const cursor = formatCursor(entries[0] as HistoryIndexEntry);
    expect(parseCursor(cursor)).toEqual({ mtimeMs: NOW - DAY, id: "ff" });
  });

  it("survives the sub-millisecond mtime that stat actually reports", () => {
    // A real cursor from this machine: `1784945108071.647.37e1ae…`. Splitting
    // on the first dot, or parsing the timestamp as an integer, both silently
    // break paging - and both are the obvious implementation.
    const fractional = entry("37e1ae5c8c0a28755c00a4cec9fa7417", 1_784_945_108_071.647);
    const cursor = parseCursor(formatCursor(fractional));
    expect(cursor).toEqual({
      mtimeMs: 1_784_945_108_071.647,
      id: "37e1ae5c8c0a28755c00a4cec9fa7417",
    });
    // Exact equality matters: the tiebreak below only fires when the parsed
    // timestamp is bit-identical to the entry's.
    expect(applyCursor([fractional], cursor as NonNullable<typeof cursor>)).toEqual([]);
  });

  it("returns null for anything malformed", () => {
    for (const raw of [undefined, "", "nodot", ".abc", "abc.def", "12"]) {
      expect(parseCursor(raw)).toBeNull();
    }
  });
});

describe("applyCursor", () => {
  it("breaks an mtime tie on the id so a page boundary is stable", () => {
    // "ee" and "dd" share an mtime. Paging from "ee" must yield "dd" exactly
    // once - not zero times, and not on both pages.
    const after = applyCursor(entries, { mtimeMs: NOW - 2 * DAY, id: "ee" });
    expect(after.map((item) => item.id)).toEqual(["dd", "cc", "bb", "aa"]);
  });
});

describe("selectPage", () => {
  const week = { sinceMs: NOW - 7 * DAY, untilMs: null };

  it("returns the default window and a cursor for the rest", () => {
    const page = selectPage({ entries, window: week, cursor: null, limit: 2 });
    expect(page.page.map((item) => item.id)).toEqual(["ff", "ee"]);
    expect(page.totalInWindow).toEqual(4);
    expect(page.nextCursor).toEqual(`${NOW - 2 * DAY}.ee`);
  });

  it("walks the whole window in pages without gaps or repeats", () => {
    const seen: string[] = [];
    let cursor = parseCursor(undefined);
    for (let guard = 0; guard < 10; guard += 1) {
      const page = selectPage({ entries, window: week, cursor, limit: 2 });
      seen.push(...page.page.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = parseCursor(page.nextCursor);
    }
    expect(seen).toEqual(["ff", "ee", "dd", "cc"]);
  });

  it("reports the same totalInWindow on every page", () => {
    const first = selectPage({ entries, window: week, cursor: null, limit: 2 });
    const second = selectPage({
      entries,
      window: week,
      cursor: parseCursor(first.nextCursor ?? undefined),
      limit: 2,
    });
    expect(second.totalInWindow).toEqual(first.totalInWindow);
  });

  it("has no cursor when the window fits in one page", () => {
    const page = selectPage({ entries, window: week, cursor: null, limit: 50 });
    expect(page.nextCursor).toBeNull();
  });

  it("an open window reaches the whole index", () => {
    const page = selectPage({
      entries,
      window: { sinceMs: null, untilMs: null },
      cursor: null,
      limit: 50,
    });
    expect(page.page).toHaveLength(6);
  });
});
