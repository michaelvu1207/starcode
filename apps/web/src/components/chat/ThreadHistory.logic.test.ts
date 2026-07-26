import type {
  HistoryForkRecord,
  HistoryImportRecord,
  HistorySessionId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadHistoryModel,
  canLoadEarlier,
  formatDateRange,
  initialHistoryPaging,
  loadEarlierHistoryPage,
  oldestCursorIndex,
  reportOldestPage,
  resolveThreadProvenance,
} from "./ThreadHistory.logic";

const THREAD_ID = "thread-imported" as ThreadId;
const SESSION_ID = "a".repeat(32) as HistorySessionId;

const importRecord = (overrides?: Partial<HistoryImportRecord>): HistoryImportRecord =>
  ({
    historySessionId: SESSION_ID,
    nativeSessionId: "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c",
    provider: "claude",
    threadId: THREAD_ID,
    projectId: "project-1" as ProjectId,
    cwd: "/work/alpha",
    importedAt: "2026-07-26T09:00:00.000Z",
    messageCount: 483,
    startedAt: "2026-07-12T09:00:00.000Z",
    sourceSizeBytes: 4_096,
    lastActivityAt: "2026-07-26T08:00:00.000Z",
    ...overrides,
  }) as HistoryImportRecord;

const forkRecord = (overrides?: Partial<HistoryForkRecord>): HistoryForkRecord =>
  ({
    threadId: "thread-fork" as ThreadId,
    sourceThreadId: "thread-source" as ThreadId,
    sourceTitle: "Reworking the picker",
    sourceSessionId: "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c",
    provider: "claude",
    projectId: "project-1" as ProjectId,
    forkedAt: "2026-07-26T09:00:00.000Z",
    historySessionId: SESSION_ID,
    sourceSizeBytes: 8_192,
    startedAt: "2026-07-12T09:00:00.000Z",
    lastActivityAt: "2026-07-26T08:00:00.000Z",
    ...overrides,
  }) as HistoryForkRecord;

describe("resolveThreadProvenance", () => {
  it("finds the import a thread came from", () => {
    const record = importRecord();
    const provenance = resolveThreadProvenance({
      imports: [record],
      forks: [],
      threadId: THREAD_ID,
    });

    expect(provenance).toEqual({ kind: "imported", record });
  });

  it("finds the fork a thread came from", () => {
    const record = forkRecord();
    const provenance = resolveThreadProvenance({
      imports: [],
      forks: [record],
      threadId: record.threadId,
    });

    expect(provenance).toEqual({ kind: "forked", record });
  });

  it("says nothing for an ordinary thread, and for a machine that cannot say", () => {
    // These three render identically — no provenance line — and deliberately
    // so: asserting a thread is ordinary when the registry never answered
    // would be the one wrong thing to say.
    expect(resolveThreadProvenance({ imports: [], forks: [], threadId: THREAD_ID })).toBeNull();
    expect(resolveThreadProvenance({ imports: null, forks: null, threadId: THREAD_ID })).toBeNull();
    expect(
      resolveThreadProvenance({ imports: [importRecord()], forks: [], threadId: null }),
    ).toBeNull();
  });
});

describe("buildThreadHistoryModel", () => {
  it("summarises an imported thread with count, range and machine", () => {
    const model = buildThreadHistoryModel({
      provenance: { kind: "imported", record: importRecord() },
      machineLabel: "simforge1",
    });

    expect(model.summary).toBe("483 messages · Jul 12 – Jul 26 · from Claude Code on simforge1");
    expect(model.sessionId).toBe(SESSION_ID);
    // The boundary is what keeps the thread's own turns out of its history.
    expect(model.before).toBe(4_096);
  });

  it("omits a message count the server could not take", () => {
    // Null means the counting scan hit its byte budget. An honest omission
    // beats a low number stated as fact — and this is the case that happens on
    // the largest sessions, which are exactly the ones worth counting.
    const model = buildThreadHistoryModel({
      provenance: { kind: "imported", record: importRecord({ messageCount: null }) },
      machineLabel: "simforge1",
    });

    expect(model.summary).toBe("Jul 12 – Jul 26 · from Claude Code on simforge1");
  });

  it("leaves the machine out when the connection has not named one", () => {
    const model = buildThreadHistoryModel({
      provenance: { kind: "imported", record: importRecord() },
      machineLabel: null,
    });

    expect(model.summary).toBe("483 messages · Jul 12 – Jul 26 · from Claude Code");
  });

  it("names the source thread for a fork, and no machine", () => {
    // A fork always lives where its source does, so naming the machine would
    // be noise on the one provenance that cannot cross machines.
    const model = buildThreadHistoryModel({
      provenance: { kind: "forked", record: forkRecord() },
      machineLabel: "simforge1",
    });

    expect(model.summary).toBe("Jul 12 – Jul 26 · forked from Reworking the picker");
    expect(model.before).toBe(8_192);
  });

  it("falls back when a fork's source had no title", () => {
    const model = buildThreadHistoryModel({
      provenance: { kind: "forked", record: forkRecord({ sourceTitle: null }) },
      machineLabel: null,
    });

    expect(model.summary).toBe("Jul 12 – Jul 26 · forked from another thread");
  });

  it("reports no session when the fork's source file was never located", () => {
    // The fork still works — it resumes through the provider's own store — so
    // this is a thread with provenance and no readable history, which the
    // caller renders as the non-interactive line.
    const model = buildThreadHistoryModel({
      provenance: {
        kind: "forked",
        record: forkRecord({ historySessionId: null, sourceSizeBytes: undefined }),
      },
      machineLabel: null,
    });

    expect(model.sessionId).toBeNull();
    expect(model.before).toBeNull();
  });

  it("reads history from the end of the file for a row with no boundary", () => {
    // Written before the boundary existed. Correct until the thread takes a
    // turn of its own, and never a reason to hide the history entirely.
    const model = buildThreadHistoryModel({
      provenance: { kind: "imported", record: importRecord({ sourceSizeBytes: undefined }) },
      machineLabel: null,
    });

    expect(model.before).toBeNull();
    expect(model.sessionId).toBe(SESSION_ID);
  });
});

describe("formatDateRange", () => {
  it("prints one date when a session began and ended the same day", () => {
    // "Jul 12 – Jul 12" reads as a formatting bug rather than a fact.
    expect(formatDateRange("2026-07-12T09:00:00.000Z", "2026-07-12T18:00:00.000Z")).toBe("Jul 12");
  });

  it("prints a range across days", () => {
    expect(formatDateRange("2026-07-12T09:00:00.000Z", "2026-07-26T18:00:00.000Z")).toBe(
      "Jul 12 – Jul 26",
    );
  });

  it("prints whichever end it has, and nothing when it has neither", () => {
    expect(formatDateRange(null, "2026-07-26T18:00:00.000Z")).toBe("Jul 26");
    expect(formatDateRange("2026-07-12T09:00:00.000Z", null)).toBe("Jul 12");
    expect(formatDateRange(null, null)).toBeNull();
  });
});

describe("history paging", () => {
  it("starts at the thread's boundary with nothing offered yet", () => {
    const state = initialHistoryPaging(4_096);

    expect(state.cursors).toEqual([4_096]);
    // Nothing is offered before the first page has said what precedes it.
    expect(canLoadEarlier(state)).toBe(false);
    expect(oldestCursorIndex(state)).toBe(0);
  });

  it("does not fetch a page to discover the next one exists", () => {
    // The cursor the oldest page reported is held outside `cursors` until
    // somebody asks for it. Merging the two would make every page a prefetch
    // of the next, and "lazy" would mean "one page behind you at all times".
    const reported = reportOldestPage(initialHistoryPaging(4_096), 2_048);

    expect(reported.cursors).toEqual([4_096]);
    expect(canLoadEarlier(reported)).toBe(true);

    const loaded = loadEarlierHistoryPage(reported);
    expect(loaded.cursors).toEqual([4_096, 2_048]);
    // And the offer retires until the newly added page answers in turn.
    expect(canLoadEarlier(loaded)).toBe(false);
    expect(oldestCursorIndex(loaded)).toBe(1);
  });

  it("retires the offer when a page reaches the top of the session", () => {
    const state = reportOldestPage(initialHistoryPaging(null), null);

    expect(state.exhausted).toBe(true);
    expect(canLoadEarlier(state)).toBe(false);
    // And a later report cannot revive it.
    expect(canLoadEarlier(reportOldestPage(state, 2_048))).toBe(false);
  });

  it("stops rather than loops when the server's cursor does not advance", () => {
    // The backwards reader has one escape hatch — a record longer than a whole
    // page budget — that can hand back a cursor pointing where we already are.
    // Without this guard, "show earlier" would refetch the same page for as
    // long as somebody kept clicking, each time appearing to do nothing.
    const walked = loadEarlierHistoryPage(reportOldestPage(initialHistoryPaging(4_096), 2_048));
    const stalled = loadEarlierHistoryPage(reportOldestPage(walked, 2_048));

    expect(stalled.cursors).toEqual([4_096, 2_048]);
    expect(stalled.exhausted).toBe(true);
    expect(canLoadEarlier(stalled)).toBe(false);
  });

  it("ignores a load with nothing to load", () => {
    const state = initialHistoryPaging(null);
    expect(loadEarlierHistoryPage(state)).toEqual(state);
  });
});
