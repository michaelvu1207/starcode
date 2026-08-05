import { describe, expect, it } from "vite-plus/test";

import {
  forkResumeCursor,
  forkThreadTitle,
  historyProviderForDriverKind,
  isForkableDriverKind,
  readBindingCwd,
  readForkableSessionCursor,
} from "./forkFacts.ts";

const SESSION_FILE = "/state/pi/sessions/thread-source/session.jsonl";
const SESSION_ID = "pi-session-source";

describe("isForkableDriverKind", () => {
  it("allows only Pi's transcript-copy primitive", () => {
    expect(isForkableDriverKind("pi")).toBe(true);
  });

  it.each(["codex", "claudeAgent", "claude", "opencode", "grok", "", null])(
    "refuses retired or unsupported driver %s",
    (kind) => {
      expect(isForkableDriverKind(kind)).toBe(false);
    },
  );
});

describe("historyProviderForDriverKind", () => {
  it("attributes native forks to Pi", () => {
    expect(historyProviderForDriverKind("pi")).toBe("pi");
  });

  it.each(["codex", "claudeAgent", "claude", "", null])(
    "does not rename legacy driver %s as Pi",
    (kind) => {
      expect(historyProviderForDriverKind(kind)).toBe(null);
    },
  );
});

describe("readForkableSessionCursor", () => {
  it("reads both Pi transcript coordinates", () => {
    expect(
      readForkableSessionCursor(
        { sessionFile: SESSION_FILE, sessionId: SESSION_ID, context: "600k" },
        "pi",
      ),
    ).toEqual({ sessionFile: SESSION_FILE, sessionId: SESSION_ID });
  });

  it.each([
    [{ sessionFile: SESSION_FILE }, "pi"],
    [{ sessionId: SESSION_ID }, "pi"],
    [{ sessionFile: "", sessionId: SESSION_ID }, "pi"],
    [{ sessionFile: SESSION_FILE, sessionId: "" }, "pi"],
    [{ threadId: "legacy-codex" }, "codex"],
    [{ resume: "legacy-claude" }, "claudeAgent"],
    [null, "pi"],
  ])("refuses incomplete or legacy cursor %j", (cursor, driver) => {
    expect(readForkableSessionCursor(cursor, driver as string)).toBe(null);
  });
});

describe("forkResumeCursor", () => {
  it("carries the strict Pi fork marker and source transcript", () => {
    expect(
      forkResumeCursor({
        sourceSessionFile: SESSION_FILE,
        sourceSessionId: SESSION_ID,
        driverKind: "pi",
      }),
    ).toEqual({
      sessionFile: SESSION_FILE,
      sessionId: SESSION_ID,
      fork: true,
    });
  });

  it.each(["codex", "claudeAgent", null])("does not mint a cursor for %s", (driverKind) => {
    expect(
      forkResumeCursor({
        sourceSessionFile: SESSION_FILE,
        sourceSessionId: SESSION_ID,
        driverKind,
      }),
    ).toEqual({});
  });
});

describe("readBindingCwd", () => {
  it("reads the working directory a session was started in", () => {
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
