// @effect-diagnostics nodeBuiltinImport:off - asserts path arithmetic against
// the same node primitives the module under test uses.
import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  claudeNativeSessionIdForPath,
  codexNativeSessionIdForPath,
  resolveSessionTitle,
  defaultInstanceIdForHistoryProvider,
  findProjectForCwd,
  importResumeCursor,
  importThreadTitle,
  instanceSessionStoreRoot,
  isPathWithin,
  projectTitleForCwd,
  IMPORT_TITLE_MAX_CHARS,
} from "./importFacts.ts";

const UUID = "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c";

describe("native session id", () => {
  it("reads Claude's resume id from the file name", () => {
    assert.equal(
      claudeNativeSessionIdForPath(`/home/me/.claude/projects/-tmp-alpha/${UUID}.jsonl`),
      UUID,
    );
  });

  it("reads Codex's resume id from the file name, not from session_meta", () => {
    // A resumed rollout appends a fresh `session_meta` every time it is
    // continued — one on this machine carries 180 — so "the id in
    // session_meta" is ambiguous in exactly the long sessions most worth
    // importing. The file name is not.
    assert.equal(
      codexNativeSessionIdForPath(
        "/home/me/.codex/sessions/2026/07/24/rollout-2026-07-24T10-00-00-019f48a7-522e-7120-a10d-285178db2830.jsonl",
      ),
      "019f48a7-522e-7120-a10d-285178db2830",
    );
  });

  it("refuses a file whose name is not a session id", () => {
    // A hand-copied log or a fragment. Both CLIs look a session up by name, so
    // there is nothing here to resume.
    assert.isNull(claudeNativeSessionIdForPath("/home/me/.claude/projects/-x/session-one.jsonl"));
    assert.isNull(claudeNativeSessionIdForPath(`/home/me/.claude/projects/-x/${UUID}.txt`));
    assert.isNull(
      codexNativeSessionIdForPath("/home/me/.codex/sessions/2026/07/24/rollout-x.jsonl"),
    );
  });
});

describe("session title", () => {
  it("prefers the title the CLI wrote for itself", () => {
    // The only rung that is a real title rather than this server guessing.
    assert.deepEqual(
      resolveSessionTitle({
        aiTitle: "check cmux  licensing\n",
        firstUserMessage: "can you look at the licence",
        projectLabel: "agent-hub",
      }),
      { title: "check cmux licensing", source: "session" },
    );
  });

  it("falls back to the first user message, and says so", () => {
    assert.deepEqual(
      resolveSessionTitle({
        aiTitle: null,
        firstUserMessage: "add a health endpoint",
        projectLabel: "agent-hub",
      }),
      { title: "add a health endpoint", source: "message" },
    );
  });

  it("falls back to the project when the session said nothing quotable", () => {
    assert.deepEqual(
      resolveSessionTitle({ aiTitle: null, firstUserMessage: null, projectLabel: "agent-hub" }),
      { title: "agent-hub", source: "project" },
    );
  });

  it("reports no title at all rather than inventing one", () => {
    assert.deepEqual(
      resolveSessionTitle({ aiTitle: null, firstUserMessage: null, projectLabel: null }),
      { title: null, source: null },
    );
  });

  it("clips a long first message to the title budget", () => {
    const resolved = resolveSessionTitle({
      aiTitle: null,
      firstUserMessage: "x".repeat(500),
      projectLabel: null,
    });
    assert.equal(resolved.title?.length, IMPORT_TITLE_MAX_CHARS + 1);
    assert.isTrue(resolved.title?.endsWith("…"));
  });
});

describe("thread title", () => {
  it("takes the name the picker showed, so importing never renames a session", () => {
    assert.equal(
      importThreadTitle({ provider: "claude", sessionTitle: "check cmux licensing" }),
      "check cmux licensing",
    );
  });

  it("names the provider when the session yielded nothing to name it after", () => {
    assert.equal(
      importThreadTitle({ provider: "codex", sessionTitle: null }),
      "Imported Codex session",
    );
  });

  it("lets the caller override everything", () => {
    assert.equal(
      importThreadTitle({ provider: "claude", sessionTitle: "derived", requested: " chosen " }),
      "chosen",
    );
  });
});

describe("instance session stores", () => {
  const home = "/home/me";

  it("maps a default Claude instance to the CLI's own store", () => {
    assert.deepEqual(
      instanceSessionStoreRoot({ driver: "claudeAgent", config: {}, homeDir: home }),
      { provider: "claude", root: NodePath.join(home, ".claude", "projects") },
    );
  });

  it("maps a Claude instance with a home to that home's projects directory", () => {
    // `homePath` is CLAUDE_CONFIG_DIR itself, not a parent of `.claude`.
    assert.deepEqual(
      instanceSessionStoreRoot({
        driver: "claudeAgent",
        config: { homePath: "~/.claude-homes/work" },
        homeDir: home,
      }),
      { provider: "claude", root: NodePath.join(home, ".claude-homes", "work", "projects") },
    );
  });

  it("maps Codex to the shared home even when the instance uses a shadow home", () => {
    // The shadow home symlinks `sessions` back to the shared one, so the
    // rollouts are only ever in one place.
    assert.deepEqual(
      instanceSessionStoreRoot({
        driver: "codex",
        config: { homePath: "~/.codex", shadowHomePath: "~/.codex-t3/personal" },
        homeDir: home,
      }),
      { provider: "codex", root: NodePath.join(home, ".codex", "sessions") },
    );
  });

  it("has no store for a driver with no on-disk session log", () => {
    assert.isNull(instanceSessionStoreRoot({ driver: "opencode", config: {}, homeDir: home }));
  });

  it("defaults to the built-in instance for each provider", () => {
    assert.equal(defaultInstanceIdForHistoryProvider("claude"), "claudeAgent");
    assert.equal(defaultInstanceIdForHistoryProvider("codex"), "codex");
  });

  it("resolves against the real home directory when none is injected", () => {
    assert.deepEqual(instanceSessionStoreRoot({ driver: "codex", config: {} }), {
      provider: "codex",
      root: NodePath.join(NodeOS.homedir(), ".codex", "sessions"),
    });
  });
});

describe("path containment", () => {
  it("accepts a file inside the root", () => {
    assert.isTrue(
      isPathWithin("/home/me/.claude/projects", "/home/me/.claude/projects/-x/a.jsonl"),
    );
  });

  it("rejects a sibling directory that merely shares a prefix", () => {
    // The whole point: `~/.claude-homes/work` must not read as `~/.claude`.
    assert.isFalse(
      isPathWithin("/home/me/.claude", "/home/me/.claude-homes/work/projects/a.jsonl"),
    );
  });

  it("rejects the root itself and anything above it", () => {
    assert.isFalse(isPathWithin("/home/me/.claude", "/home/me/.claude"));
    assert.isFalse(isPathWithin("/home/me/.claude/projects", "/home/me/.claude/a.jsonl"));
  });
});

describe("project matching", () => {
  const projects = [
    { id: "project-a", workspaceRoot: "/tmp/alpha" },
    { id: "project-b", workspaceRoot: "/tmp/beta/" },
  ];

  it("matches on the resolved path, trailing separator and all", () => {
    assert.equal(findProjectForCwd(projects, "/tmp/beta")?.id, "project-b");
    assert.equal(findProjectForCwd(projects, "/tmp/alpha/")?.id, "project-a");
  });

  it("refuses an ancestor project", () => {
    // A thread filed under `/tmp/alpha` would run there, and Claude would then
    // look for the session in the wrong project store.
    assert.isNull(findProjectForCwd(projects, "/tmp/alpha/packages/api"));
  });

  it("titles a new project after the directory it is rooted at", () => {
    assert.equal(projectTitleForCwd("/tmp/alpha/packages/api"), "api");
  });
});

describe("resume cursors", () => {
  it("writes Claude's four-field cursor with the native id in `resume`", () => {
    // `readClaudeResumeState` only resumes on `resume`, and only when it is a
    // uuid; `turnCount` counts this thread's turns, which is zero at import.
    assert.deepEqual(
      importResumeCursor({ provider: "claude", threadId: "thread-1", nativeSessionId: UUID }),
      { threadId: "thread-1", resume: UUID, turnCount: 0 },
    );
  });

  it("writes Codex's single-field cursor with the rollout id as `threadId`", () => {
    // Codex's cursor schema is `{ threadId }` and that id is the *rollout's*,
    // not t3's — it is passed straight to `thread/resume`.
    assert.deepEqual(
      importResumeCursor({ provider: "codex", threadId: "thread-1", nativeSessionId: UUID }),
      { threadId: UUID },
    );
  });
});
