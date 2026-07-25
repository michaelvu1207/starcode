import type { EnvironmentId, HistorySessionsPage, HistorySessionSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  foldHistoryStripPages,
  historySessionsKeyFor,
  historyStripMoreLabel,
  historyStripUnsupported,
  historyStripWindow,
  resolveSidebarTerminalHistoryExpanded,
  sidebarTerminalHistoryExpansionKey,
  HISTORY_STRIP_FIRST_PAGE,
  HISTORY_STRIP_PAGE_SIZE,
} from "./Sidebar.history";

const LOCAL = "env-local" as EnvironmentId;

const session = (id: string): HistorySessionSummary => ({
  id: id as HistorySessionSummary["id"],
  provider: "claude",
  projectPath: "/w/app",
  projectLabel: "app",
  snippet: `prompt ${id}`,
  title: `prompt ${id}`,
  titleSource: "message",
  lastActivityAt: "2026-07-24T10:00:00.000Z",
  sizeBytes: 1_000,
});

const page = (input: {
  readonly ids: ReadonlyArray<string>;
  readonly nextCursor?: string | null;
  readonly totalAvailable?: number;
  readonly totalInWindow?: number;
}): HistorySessionsPage => ({
  sessions: input.ids.map(session),
  nextCursor: (input.nextCursor ?? null) as HistorySessionsPage["nextCursor"],
  totalAvailable: input.totalAvailable ?? input.ids.length,
  totalInWindow: input.totalInWindow ?? input.ids.length,
  since: "2026-07-17T10:00:00.000Z",
  indexedAt: "2026-07-24T10:00:00.000Z",
});

describe("expansion key", () => {
  it("defaults collapsed, which is what makes the strip lazy", () => {
    // A connection group defaults open; this deliberately does not, so opening
    // the sidebar never fetches history from four machines.
    expect(resolveSidebarTerminalHistoryExpanded({}, LOCAL)).toBe(false);
    expect(
      resolveSidebarTerminalHistoryExpanded(
        { [sidebarTerminalHistoryExpansionKey(LOCAL)]: true },
        LOCAL,
      ),
    ).toBe(true);
  });

  it("namespaces the key so it cannot collide with a project or a group", () => {
    expect(sidebarTerminalHistoryExpansionKey(LOCAL)).toEqual(
      "sidebar-connection-history:env-local",
    );
  });
});

describe("historySessionsKeyFor", () => {
  it("omits the window on the first page so the server applies its own default", () => {
    expect(historySessionsKeyFor(LOCAL, HISTORY_STRIP_FIRST_PAGE)).toEqual({
      environmentId: LOCAL,
      limit: HISTORY_STRIP_PAGE_SIZE,
    });
  });

  it("carries an opened window and a cursor when paging", () => {
    expect(historySessionsKeyFor(LOCAL, { since: "", cursor: "123.abc" })).toEqual({
      environmentId: LOCAL,
      since: "",
      cursor: "123.abc",
      limit: HISTORY_STRIP_PAGE_SIZE,
    });
  });
});

describe("historyStripWindow", () => {
  it("distinguishes the default window from the opened one", () => {
    expect(historyStripWindow({})).toEqual("recent");
    expect(historyStripWindow({ since: "" })).toEqual("all");
  });
});

describe("foldHistoryStripPages", () => {
  it("starts by asking for the first page", () => {
    const state = foldHistoryStripPages([]);
    expect(state.sessions).toEqual([]);
    expect(state.nextRequest).toEqual(HISTORY_STRIP_FIRST_PAGE);
  });

  it("follows the cursor while one is offered", () => {
    const state = foldHistoryStripPages([
      { request: {}, page: page({ ids: ["a", "b"], nextCursor: "9.b", totalAvailable: 10 }) },
    ]);
    expect(state.sessions.map((item) => item.id)).toEqual(["a", "b"]);
    expect(state.nextRequest).toEqual({ cursor: "9.b" });
    expect(state.window).toEqual("recent");
  });

  it("counts against the window it is paging, not the whole index", () => {
    // Live on this Mac the difference is "Show more (12)" versus a promise of
    // 3,583 that the next click does not keep.
    const state = foldHistoryStripPages([
      {
        request: {},
        page: page({
          ids: ["a", "b"],
          nextCursor: "9.b",
          totalInWindow: 24,
          totalAvailable: 3_595,
        }),
      },
    ]);
    expect(historyStripMoreLabel(state)).toEqual("Show more (22)");
    expect(state.remainingBeyondWindow).toEqual(3_593);
  });

  it("reopens the window when the recent one runs out but the index holds more", () => {
    // The hand-off that makes full history reachable without ever asking for
    // it up front. The `until` bound is what stops the reopened page from
    // being the same rows again: verified live, where reopening unbounded
    // re-listed all 24 recent sessions and the click appeared to do nothing.
    const state = foldHistoryStripPages([
      { request: {}, page: page({ ids: ["a", "b"], nextCursor: null, totalAvailable: 500 }) },
    ]);
    expect(state.nextRequest).toEqual({ since: "", until: "2026-07-24T10:00:00.000Z" });
    expect(state.remainingBeyondWindow).toEqual(498);
    expect(historyStripMoreLabel(state)).toEqual("Show older (498)");
  });

  it("stops for real once the opened window is exhausted", () => {
    const state = foldHistoryStripPages([
      { request: { since: "" }, page: page({ ids: ["a"], nextCursor: null, totalAvailable: 1 }) },
    ]);
    expect(state.nextRequest).toBeNull();
    expect(historyStripMoreLabel(state)).toBeNull();
  });

  it("deduplicates a session that appears on two pages", () => {
    // The index revalidates between requests, so a session written to in
    // between can legitimately show up twice.
    const state = foldHistoryStripPages([
      { request: {}, page: page({ ids: ["a", "b"], nextCursor: "9.b", totalAvailable: 3 }) },
      { request: { cursor: "9.b" }, page: page({ ids: ["b", "c"], totalAvailable: 3 }) },
    ]);
    expect(state.sessions.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("never reports a negative remaining count", () => {
    const state = foldHistoryStripPages([
      { request: {}, page: page({ ids: ["a", "b", "c"], totalAvailable: 1 }) },
    ]);
    expect(state.remainingCount).toEqual(0);
  });
});

describe("historyStripUnsupported", () => {
  it("is false while the first page is still loading", () => {
    // The failure mode this rules out: a spinner that never resolves.
    expect(historyStripUnsupported({ pending: true, firstPage: null })).toBe(false);
  });

  it("is true once a machine has resolved to nothing at all", () => {
    // A server predating these routes 404s, and the loader maps that to a
    // resolved absence rather than an error.
    expect(historyStripUnsupported({ pending: false, firstPage: null })).toBe(true);
  });

  it("is false for a machine that answered with an empty listing", () => {
    expect(historyStripUnsupported({ pending: false, firstPage: page({ ids: [] }) })).toBe(false);
  });
});
