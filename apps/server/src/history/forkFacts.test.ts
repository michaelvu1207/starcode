import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkResumeCursor,
  forkThreadTitle,
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

  it("refuses Codex, whose app-server can only resume in place", () => {
    // Not a gap to fill later with an equality flip: `thread/resume` appends to
    // the same rollout file, so a Codex "fork" would be two threads writing one
    // transcript — and Codex answers an unknown thread id with a fresh empty
    // thread rather than an error, so it would fail silently.
    expect(isForkableDriverKind("codex")).toBe(false);
  });

  it.each(["opencode", "gemini", "grok", "claudeagent", "", null])(
    "refuses %s until it is proven",
    (kind) => {
      expect(isForkableDriverKind(kind)).toBe(false);
    },
  );
});

describe("readForkableSessionId", () => {
  it("reads the cursor field the adapter writes", () => {
    expect(readForkableSessionId({ threadId: "t-1", resume: SESSION, turnCount: 3 })).toBe(SESSION);
  });

  it("reads the older spelling the adapter still accepts", () => {
    expect(readForkableSessionId({ sessionId: SESSION })).toBe(SESSION);
  });

  it("prefers `resume` when a cursor carries both", () => {
    expect(readForkableSessionId({ resume: SESSION, sessionId: "not-a-uuid" })).toBe(SESSION);
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
      expect(readForkableSessionId(cursor)).toBe(null);
    }
  });
});

describe("forkResumeCursor", () => {
  const cursor = forkResumeCursor({
    threadId: ThreadId.make("thread-fork"),
    sourceSessionId: SESSION,
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
