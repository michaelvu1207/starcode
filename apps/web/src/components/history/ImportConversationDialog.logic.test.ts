import type { HistoryImportAttempt } from "@starcode/client-runtime/state/terminal-history";
import type {
  EnvironmentId,
  HistoryImportRecord,
  HistoryImportRefusalReason,
  HistorySessionId,
  HistorySessionSummary,
  HistoryTranscriptEntry,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  IMPORT_PICKER_UNTITLED_LABEL,
  IMPORT_PREVIEW_CAPTION_MAX_CHARS,
  buildImportPickerRows,
  buildImportPreviewTimeline,
  describeImportRefusal,
  findHistoryImportForThread,
  formatHistoryAge,
  formatImportPreludeLine,
  matchesImportPickerFilter,
  resolveImportAttempt,
  resolveImportPickerScope,
} from "./ImportConversationDialog.logic";

const NOW_MS = Date.parse("2026-07-25T12:00:00.000Z");

function session(overrides: Partial<HistorySessionSummary> = {}): HistorySessionSummary {
  return {
    id: "a".repeat(32) as HistorySessionId,
    provider: "claude",
    projectPath: "/Users/m/code/simcloud",
    projectLabel: "simcloud",
    snippet: "why is the sidebar empty",
    title: "sidebar empty state",
    titleSource: "session",
    lastActivityAt: "2026-07-25T11:00:00.000Z",
    sizeBytes: 4_096,
    ...overrides,
  } as HistorySessionSummary;
}

function importRecord(overrides: Partial<HistoryImportRecord> = {}): HistoryImportRecord {
  return {
    historySessionId: "a".repeat(32) as HistorySessionId,
    nativeSessionId: "4f2c0d1e-0000-4000-8000-000000000000",
    provider: "claude",
    threadId: "thread-1" as ThreadId,
    projectId: "project-1" as ProjectId,
    cwd: "/Users/m/code/simcloud",
    importedAt: "2026-07-25T10:00:00.000Z",
    messageCount: 483,
    startedAt: "2026-07-12T09:30:00.000Z",
    ...overrides,
  } as HistoryImportRecord;
}

describe("buildImportPickerRows", () => {
  it("marks a title the session wrote for itself as authoritative", () => {
    const [row] = buildImportPickerRows({
      sessions: [session({ title: "check cmux licensing", titleSource: "session" })],
      imports: [],
      nowMs: NOW_MS,
    });

    expect(row?.title).toBe("check cmux licensing");
    expect(row?.titleIsDerived).toBe(false);
  });

  it("marks a title derived from a message or a directory as derived", () => {
    const rows = buildImportPickerRows({
      sessions: [
        session({ title: "why is the sidebar empty", titleSource: "message" }),
        session({
          id: "b".repeat(32) as HistorySessionId,
          title: "simcloud",
          titleSource: "project",
        }),
      ],
      imports: [],
      nowMs: NOW_MS,
    });

    expect(rows.map((row) => row.titleIsDerived)).toEqual([true, true]);
  });

  it("falls back to a placeholder when the file yielded no name, and calls it derived", () => {
    const [row] = buildImportPickerRows({
      sessions: [session({ title: null, titleSource: null })],
      imports: [],
      nowMs: NOW_MS,
    });

    expect(row?.title).toBe(IMPORT_PICKER_UNTITLED_LABEL);
    expect(row?.titleIsDerived).toBe(true);
  });

  it("carries the thread a previous import produced", () => {
    const [row] = buildImportPickerRows({
      sessions: [session()],
      imports: [importRecord()],
      nowMs: NOW_MS,
    });

    expect(row?.importedThreadId).toBe("thread-1");
  });

  it("badges nothing when the machine could not say what it has imported", () => {
    // An unknown registry must not read as an empty one: importing twice is
    // safe, claiming a session is fresh when it is not is confusing.
    const [row] = buildImportPickerRows({ sessions: [session()], imports: null, nowMs: NOW_MS });

    expect(row?.importedThreadId).toBeNull();
  });

  it("does not badge a row whose session id is not in the registry", () => {
    const [row] = buildImportPickerRows({
      sessions: [session()],
      imports: [importRecord({ historySessionId: "c".repeat(32) as HistorySessionId })],
      nowMs: NOW_MS,
    });

    expect(row?.importedThreadId).toBeNull();
  });
});

describe("matchesImportPickerFilter", () => {
  const [row] = buildImportPickerRows({ sessions: [session()], imports: [], nowMs: NOW_MS });

  it("matches title, snippet and project, case-insensitively", () => {
    expect(matchesImportPickerFilter(row!, "SIDEBAR")).toBe(true);
    expect(matchesImportPickerFilter(row!, "empty state")).toBe(true);
    expect(matchesImportPickerFilter(row!, "simcloud")).toBe(true);
  });

  it("keeps everything when the query is blank and drops what does not match", () => {
    expect(matchesImportPickerFilter(row!, "   ")).toBe(true);
    expect(matchesImportPickerFilter(row!, "godot")).toBe(false);
  });
});

describe("formatHistoryAge", () => {
  it("tightens as the session gets older, then falls back to a date", () => {
    expect(formatHistoryAge("2026-07-25T11:59:30.000Z", NOW_MS)).toBe("now");
    expect(formatHistoryAge("2026-07-25T11:20:00.000Z", NOW_MS)).toBe("40m");
    expect(formatHistoryAge("2026-07-25T06:00:00.000Z", NOW_MS)).toBe("6h");
    expect(formatHistoryAge("2026-07-22T12:00:00.000Z", NOW_MS)).toBe("3d");
    expect(formatHistoryAge("2026-06-01T12:00:00.000Z", NOW_MS)).not.toBe("");
  });

  it("renders nothing rather than NaN for an unparseable timestamp", () => {
    expect(formatHistoryAge("not-a-date", NOW_MS)).toBe("");
  });
});

describe("describeImportRefusal", () => {
  const reasons: ReadonlyArray<HistoryImportRefusalReason> = [
    "session_unreadable",
    "session_id_unusable",
    "session_cwd_unknown",
    "instance_not_found",
    "instance_disabled",
    "instance_driver_mismatch",
    "instance_home_mismatch",
    "model_unavailable",
    "project_not_found",
    "project_cwd_mismatch",
    "project_create_failed",
    "thread_create_failed",
    "binding_write_failed",
  ];

  it("gives every reason its own sentence", () => {
    const sentences = reasons.map((reason) => describeImportRefusal(reason, null));

    expect(sentences.every((sentence) => sentence.trim().length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(reasons.length);
  });

  it("appends the server's detail rather than interpolating it", () => {
    const message = describeImportRefusal("instance_home_mismatch", "~/.claude-work");

    expect(message).toContain("different CLI home");
    expect(message).toContain("(~/.claude-work)");
  });

  it("ignores an empty detail", () => {
    expect(describeImportRefusal("thread_create_failed", "  ")).not.toContain("(");
  });
});

describe("resolveImportAttempt", () => {
  it("opens the thread an import produced", () => {
    const attempt: HistoryImportAttempt = {
      kind: "imported",
      result: {
        status: "imported",
        alreadyImported: false,
        threadId: "thread-9" as ThreadId,
        projectId: "project-1" as ProjectId,
        cwd: "/Users/m/code/simcloud",
        nativeSessionId: "4f2c0d1e-0000-4000-8000-000000000000",
        provider: "claude",
        providerInstanceId: "claudeAgent" as ProviderInstanceId,
        title: "sidebar empty state",
        messageCount: 483,
        startedAt: "2026-07-12T09:30:00.000Z",
      },
    };

    expect(resolveImportAttempt(attempt)).toEqual({ kind: "openThread", threadId: "thread-9" });
  });

  it("opens the original thread when the session was already imported", () => {
    const attempt: HistoryImportAttempt = {
      kind: "imported",
      result: {
        status: "imported",
        alreadyImported: true,
        threadId: "thread-1" as ThreadId,
        projectId: "project-1" as ProjectId,
        cwd: "/Users/m/code/simcloud",
        nativeSessionId: "4f2c0d1e-0000-4000-8000-000000000000",
        provider: "claude",
        providerInstanceId: "claudeAgent" as ProviderInstanceId,
        title: "sidebar empty state",
        messageCount: null,
        startedAt: null,
      },
    };

    expect(resolveImportAttempt(attempt)).toEqual({ kind: "openThread", threadId: "thread-1" });
  });

  it("asks once, showing the directory, when no project is rooted at the session's cwd", () => {
    const attempt: HistoryImportAttempt = {
      kind: "needsProject",
      result: {
        status: "needs_project",
        cwd: "/Users/m/code/simcloud",
        suggestedProjectTitle: "simcloud",
        provider: "claude",
        providerInstanceId: "claudeAgent" as ProviderInstanceId,
        suggestedThreadTitle: "sidebar empty state",
      },
    };

    expect(resolveImportAttempt(attempt)).toEqual({
      kind: "prompt",
      prompt: { kind: "needsProject", cwd: "/Users/m/code/simcloud", projectTitle: "simcloud" },
    });
  });

  it("turns a refusal into the sentence for its reason", () => {
    const outcome = resolveImportAttempt({
      kind: "refused",
      reason: "project_cwd_mismatch",
      detail: "/elsewhere",
    });

    expect(outcome).toEqual({
      kind: "prompt",
      prompt: {
        kind: "error",
        message: describeImportRefusal("project_cwd_mismatch", "/elsewhere"),
      },
    });
  });

  it("passes an unreachable machine through as its own message", () => {
    expect(resolveImportAttempt({ kind: "unavailable", message: "Timed out." })).toEqual({
      kind: "prompt",
      prompt: { kind: "error", message: "Timed out." },
    });
  });
});

describe("buildImportPreviewTimeline", () => {
  const entry = (overrides: Partial<HistoryTranscriptEntry> = {}): HistoryTranscriptEntry =>
    ({
      offset: 0,
      role: "assistant",
      text: "done",
      truncated: false,
      toolCalls: [],
      timestamp: "2026-07-25T11:00:00.000Z",
      ...overrides,
    }) as HistoryTranscriptEntry;

  it("makes the tail the content, in the order a thread is read", () => {
    const tail = [entry({ offset: 10 }), entry({ offset: 20 }), entry({ offset: 30 })];

    const timeline = buildImportPreviewTimeline({ opening: null, tail, gap: false });

    expect(timeline.entries).toEqual(tail);
  });

  it("demotes the opening message to a one-line caption", () => {
    const timeline = buildImportPreviewTimeline({
      opening: entry({ role: "user", text: "why is the sidebar\n  empty on   startup" }),
      tail: [entry({ offset: 10 })],
      gap: true,
    });

    // Whitespace collapsed, because this renders on one line next to a label.
    expect(timeline.caption).toBe("why is the sidebar empty on startup");
    expect(timeline.entries).toHaveLength(1);
  });

  it("clips a long opening rather than letting it wrap", () => {
    const timeline = buildImportPreviewTimeline({
      opening: entry({ role: "user", text: "x".repeat(400) }),
      tail: [],
      gap: true,
    });

    expect(timeline.caption).toHaveLength(IMPORT_PREVIEW_CAPTION_MAX_CHARS + 1);
    expect(timeline.caption?.endsWith("…")).toBe(true);
  });

  it("prints no caption when the opening is already in the tail", () => {
    // The server sends `opening: null` for a session short enough that its
    // first message is one of the last few — captioning it would duplicate it.
    const timeline = buildImportPreviewTimeline({
      opening: null,
      tail: [entry({ offset: 10, role: "user", text: "say only: ok" })],
      gap: false,
    });

    expect(timeline.caption).toBeNull();
    expect(timeline.showBreak).toBe(false);
  });

  it("only breaks the timeline when something is missing above the break", () => {
    const withGap = buildImportPreviewTimeline({
      opening: entry({ role: "user", text: "start" }),
      tail: [entry({ offset: 10 })],
      gap: true,
    });
    const withoutGap = buildImportPreviewTimeline({
      opening: entry({ role: "user", text: "start" }),
      tail: [entry({ offset: 10 })],
      gap: false,
    });
    // A gap with no caption above it would be a rule the eye cannot explain.
    const gapButNoCaption = buildImportPreviewTimeline({
      opening: null,
      tail: [entry({ offset: 10 })],
      gap: true,
    });

    expect(withGap.showBreak).toBe(true);
    expect(withoutGap.showBreak).toBe(false);
    expect(gapButNoCaption.showBreak).toBe(false);
  });

  it("survives a machine that could not serve a preview at all", () => {
    expect(buildImportPreviewTimeline(null)).toEqual({
      caption: null,
      entries: [],
      showBreak: false,
    });
  });

  it("drops a whitespace-only opening rather than captioning an empty string", () => {
    const timeline = buildImportPreviewTimeline({
      opening: entry({ role: "user", text: "   \n  " }),
      tail: [entry({ offset: 10 })],
      gap: true,
    });

    expect(timeline.caption).toBeNull();
  });
});

describe("resolveImportPickerScope", () => {
  const primary = "env-mac" as EnvironmentId;
  const other = "env-pathpc" as EnvironmentId;

  it("honours a request that already names a machine", () => {
    expect(
      resolveImportPickerScope({
        requested: other,
        primaryEnvironmentId: primary,
        environmentIds: [primary, other],
      }),
    ).toBe(other);
  });

  it("falls back to the local machine for a fleet-wide request", () => {
    expect(
      resolveImportPickerScope({
        requested: null,
        primaryEnvironmentId: primary,
        environmentIds: [primary, other],
      }),
    ).toBe(primary);
  });

  it("falls back to any paired machine when there is no local one", () => {
    expect(
      resolveImportPickerScope({
        requested: null,
        primaryEnvironmentId: null,
        environmentIds: [other],
      }),
    ).toBe(other);
  });

  it("resolves to nothing when no machine is paired at all", () => {
    expect(
      resolveImportPickerScope({
        requested: null,
        primaryEnvironmentId: null,
        environmentIds: [],
      }),
    ).toBeNull();
  });
});

describe("the imported-thread prelude", () => {
  it("names the CLI, the size and the date", () => {
    expect(
      formatImportPreludeLine({
        provider: "claude",
        messageCount: 483,
        startedAt: "2026-07-12T09:30:00.000Z",
      }),
    ).toBe("Resumed from a Claude Code terminal session · 483 messages · Jul 12");
  });

  it("says nothing about a count the server could not finish", () => {
    expect(
      formatImportPreludeLine({
        provider: "codex",
        messageCount: null,
        startedAt: "2026-07-12T09:30:00.000Z",
      }),
    ).toBe("Resumed from a Codex terminal session · Jul 12");
  });

  it("keeps the sentence readable at one message and with no start date", () => {
    expect(formatImportPreludeLine({ provider: "claude", messageCount: 1, startedAt: null })).toBe(
      "Resumed from a Claude Code terminal session · 1 message",
    );
  });

  it("finds the record for the thread being viewed and no other", () => {
    const imports = [
      importRecord(),
      importRecord({
        historySessionId: "b".repeat(32) as HistorySessionId,
        threadId: "thread-2" as ThreadId,
      }),
    ];

    expect(findHistoryImportForThread(imports, "thread-2" as ThreadId)?.threadId).toBe("thread-2");
    expect(findHistoryImportForThread(imports, "thread-3" as ThreadId)).toBeNull();
  });

  it("shows nothing for an ordinary thread, or when the registry is unknown", () => {
    expect(findHistoryImportForThread(null, "thread-1" as ThreadId)).toBeNull();
    expect(findHistoryImportForThread([importRecord()], null)).toBeNull();
  });
});
