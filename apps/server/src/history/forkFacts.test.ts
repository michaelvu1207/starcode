import { ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkResumeCursor,
  forkThreadTitle,
  historyProviderForDriverKind,
  isForkableDriverKind,
  readBindingCwd,
  readForkableSessionId,
} from "./forkFacts.ts";

const SESSION = "6b1f2c3d-4e5a-4b7c-8d9e-0f1a2b3c4d5e";

describe("isForkableDriverKind", () => {
  it("allows Claude, whose SDK can fork a session", () => {
    // `claudeAgent` is the ProviderDriverKind the Claude driver registers. It
    // is NOT the `HistoryProvider` spelling ("claude") this module's result
    // type uses, and confusing the two refuses every real Claude thread while
    // looking exactly like a feature that was never wired up.
    expect(isForkableDriverKind("claudeAgent")).toBe(true);
    expect(isForkableDriverKind("claude")).toBe(false);
  });

  it("allows Codex, whose app-server has thread/fork", () => {
    // `thread/fork` reads the source rollout and opens a new one, which is the
    // property that matters: the source is read and never written. Plain
    // `thread/resume` would append to the source's own file, so this staying
    // true depends on `openCodexThread` never falling back to resume when a
    // fork fails — see the comment there.
    expect(isForkableDriverKind("codex")).toBe(true);
  });

  it.each(["opencode", "gemini", "grok", "claudeagent", "", null])(
    "refuses %s until it is proven",
    (kind) => {
      expect(isForkableDriverKind(kind)).toBe(false);
    },
  );
});

describe("historyProviderForDriverKind", () => {
  it("translates between the two vocabularies a fork straddles", () => {
    // The provenance row spells Claude's provider "claude" while the driver
    // kind is "claudeAgent". A caller that hardcoded either would write a row
    // naming the wrong provider, and nothing would fail at the time.
    expect(historyProviderForDriverKind("claudeAgent")).toBe("claude");
    expect(historyProviderForDriverKind("codex")).toBe("codex");
  });

  it("agrees with isForkableDriverKind about who can fork", () => {
    // These two lists disagreeing is the failure this pairing exists to catch:
    // a driver added to one and not the other either forks and writes a wrong
    // provenance row, or is refused for a reason that is not true.
    for (const kind of ["claudeAgent", "codex"]) {
      expect(isForkableDriverKind(kind)).toBe(true);
      expect(historyProviderForDriverKind(kind)).not.toBe(null);
    }
  });

  it.each(["opencode", "claude", "gemini", "", null])("has no name for %s", (kind) => {
    expect(historyProviderForDriverKind(kind)).toBe(null);
  });
});

describe("readForkableSessionId", () => {
  it("reads the cursor field the adapter writes", () => {
    expect(
      readForkableSessionId({ threadId: "t-1", resume: SESSION, turnCount: 3 }, "claudeAgent"),
    ).toBe(SESSION);
  });

  it("reads the older spelling the adapter still accepts", () => {
    expect(readForkableSessionId({ sessionId: SESSION }, "claudeAgent")).toBe(SESSION);
  });

  it("prefers `resume` when a cursor carries both", () => {
    expect(readForkableSessionId({ resume: SESSION, sessionId: "not-a-uuid" }, "claudeAgent")).toBe(
      SESSION,
    );
  });

  it("refuses anything that is not a session file's name", () => {
    // The id names a file. Asking the SDK to resume a non-UUID fails at the far
    // end of a process spawn, which is a much worse place to find out.
    for (const cursor of [
      { resume: "claude-thread-42" },
      { resume: "" },
      { resume: 7 },
      { resume: `${SESSION}/../../etc/passwd` },
      {},
      null,
      "a string",
      undefined,
    ]) {
      expect(readForkableSessionId(cursor, "claudeAgent")).toBe(null);
    }
  });
});

describe("readForkableSessionId, on Codex", () => {
  it("reads the app-server thread id rather than a session file's name", () => {
    // Codex's cursor names a thread, not a file, and its shape is the app
    // server's business. Validating it against Claude's UUID pattern would
    // refuse every real Codex thread.
    expect(readForkableSessionId({ threadId: "0199c2f1-codex-thread" }, "codex")).toBe(
      "0199c2f1-codex-thread",
    );
  });

  it("does not read Claude's field for a Codex thread", () => {
    // The two cursors agree on nothing, and `resume` on a Codex cursor would be
    // a field nothing wrote.
    expect(readForkableSessionId({ resume: SESSION }, "codex")).toBe(null);
  });

  it.each([{ threadId: "" }, { threadId: 7 }, {}, null, undefined])(
    "answers null for %s",
    (cursor) => {
      expect(readForkableSessionId(cursor, "codex")).toBe(null);
    },
  );
});

describe("forkResumeCursor", () => {
  const cursor = forkResumeCursor({
    threadId: ThreadId.make("thread-fork"),
    sourceSessionId: SESSION,
    driverKind: "claudeAgent",
  });

  it("carries the marker that makes the provider fork rather than continue", () => {
    // The whole safety property. Without `fork`, the adapter resumes the source
    // session in place and both threads append to one transcript.
    expect(cursor.fork).toBe(true);
    expect(cursor.resume).toBe(SESSION);
  });

  it("is the forked thread's own cursor, not a copy of the source's", () => {
    expect(cursor.threadId).toBe("thread-fork");
    // The fork has said nothing yet. Seeding this from the source would make
    // the fork's first turn read as a continuation in every log that sees it.
    expect(cursor.turnCount).toBe(0);
  });

  it("does not truncate the resume at the source's last message", () => {
    // `resumeSessionAt` rewinds a resume to a given assistant message. Carrying
    // the source's value would silently give the fork less history than the
    // source has, which is the one difference a user would never think to check.
    expect("resumeSessionAt" in cursor).toBe(false);
  });
});

describe("forkResumeCursor, on Codex", () => {
  const cursor = forkResumeCursor({
    threadId: ThreadId.make("thread-fork"),
    sourceSessionId: "source-codex-thread",
    driverKind: "codex",
  });

  it("points the cursor at the source thread, which is what thread/fork takes", () => {
    // Note this is the *source's* id under `threadId`, not the new thread's —
    // the opposite of Claude's cursor, because the Codex adapter reads this
    // field as "the thread to open" rather than "the thread I am".
    expect(cursor.threadId).toBe("source-codex-thread");
    expect(cursor.fork).toBe(true);
  });

  it("stays durable unless the caller asks for an ephemeral fork", () => {
    expect("ephemeral" in cursor).toBe(false);
  });

  it("carries ephemeral for a side thread", () => {
    const side = forkResumeCursor({
      threadId: ThreadId.make("thread-side"),
      sourceSessionId: "source-codex-thread",
      driverKind: "codex",
      ephemeral: true,
    });
    expect(side.ephemeral).toBe(true);
  });

  it("does not fake ephemeral on Claude, which has no equivalent", () => {
    // A cursor carrying a field its adapter ignores reads as a promise this
    // code cannot keep. A Claude side thread is ephemeral in our store and
    // durable in the SDK's, and that is the honest description.
    const claudeSide = forkResumeCursor({
      threadId: ThreadId.make("thread-side"),
      sourceSessionId: SESSION,
      driverKind: "claudeAgent",
      ephemeral: true,
    });
    expect("ephemeral" in claudeSide).toBe(false);
  });
});

describe("readBindingCwd", () => {
  it("reads the working directory a session was started in", () => {
    // Not the project's root: a thread on a worktree runs somewhere its project
    // does not, and Claude's session store is keyed by working directory.
    expect(readBindingCwd({ cwd: "/repo/.worktrees/feat" })).toBe("/repo/.worktrees/feat");
  });

  it.each([{ cwd: "" }, { cwd: 3 }, {}, null, "string", undefined])(
    "answers null for %s rather than inventing one",
    (payload) => {
      expect(readBindingCwd(payload)).toBe(null);
    },
  );
});

describe("forkThreadTitle", () => {
  it("names the fork after its source", () => {
    expect(forkThreadTitle("Trace the dropped frames")).toBe("Trace the dropped frames (fork)");
  });

  it("keeps the title short enough to still truncate in a row", () => {
    const title = forkThreadTitle("x".repeat(400));
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith(" (fork)")).toBe(true);
    expect(title).toContain("…");
  });

  it("never produces the blank title thread.create refuses", () => {
    expect(forkThreadTitle("  spaced  ")).toBe("spaced (fork)");
  });
});
