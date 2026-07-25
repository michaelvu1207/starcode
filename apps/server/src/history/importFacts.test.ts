// @effect-diagnostics nodeBuiltinImport:off - asserts path arithmetic against
// the same node primitives the module under test uses.
import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  claudeNativeSessionIdForPath,
  defaultInstanceIdForHistoryProvider,
  findProjectForCwd,
  importResumeCursor,
  importThreadTitle,
  instanceSessionStoreRoot,
  isPathWithin,
  projectTitleForCwd,
  SessionImportFold,
  IMPORT_TITLE_MAX_CHARS,
} from "./importFacts.ts";

const UUID = "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c";

const claudeRecord = (fields: Record<string, unknown>): string => JSON.stringify(fields);

const foldLines = (provider: "claude" | "codex", lines: ReadonlyArray<string>) => {
  const fold = new SessionImportFold(provider);
  for (const line of lines) {
    if (fold.push(line)) break;
  }
  return fold.result;
};

describe("native session id", () => {
  it("reads Claude's resume id from the file name", () => {
    assert.equal(
      claudeNativeSessionIdForPath(`/home/me/.claude/projects/-tmp-alpha/${UUID}.jsonl`),
      UUID,
    );
  });

  it("refuses a Claude file whose name is not a session id", () => {
    // A hand-copied log or a fragment. `claude --resume` looks up the file by
    // name, so there is nothing here to resume.
    assert.isNull(claudeNativeSessionIdForPath("/home/me/.claude/projects/-x/session-one.jsonl"));
    assert.isNull(claudeNativeSessionIdForPath(`/home/me/.claude/projects/-x/${UUID}.txt`));
  });
});

describe("session facts", () => {
  it("reads a Claude session's working directory and first human turn", () => {
    const facts = foldLines("claude", [
      claudeRecord({ type: "queue-operation", sessionId: UUID }),
      claudeRecord({
        type: "user",
        cwd: "/tmp/alpha",
        message: { role: "user", content: "remember the codeword" },
      }),
    ]);

    assert.equal(facts.cwd, "/tmp/alpha");
    assert.equal(facts.firstUserMessage, "remember the codeword");
    assert.isNull(facts.summary);
    // Claude's id is in the path, never in the records.
    assert.isNull(facts.nativeSessionId);
  });

  it("prefers a Claude summary record as the title source", () => {
    const facts = foldLines("claude", [
      claudeRecord({ type: "summary", summary: "Wiring the import  endpoint\n" }),
      claudeRecord({
        type: "user",
        cwd: "/tmp/alpha",
        message: { role: "user", content: "carry on" },
      }),
    ]);

    assert.equal(facts.summary, "Wiring the import endpoint");
    assert.equal(importThreadTitle({ facts, provider: "claude" }), "Wiring the import endpoint");
  });

  it("reads a Codex rollout's thread id and cwd from session_meta", () => {
    const facts = foldLines("codex", [
      JSON.stringify({
        type: "session_meta",
        payload: { id: UUID, session_id: UUID, cwd: "/tmp/beta" },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "ship it" } }),
    ]);

    assert.equal(facts.nativeSessionId, UUID);
    assert.equal(facts.cwd, "/tmp/beta");
    assert.equal(facts.firstUserMessage, "ship it");
  });

  it("falls back to session_id on a rollout that predates the `id` field", () => {
    const facts = foldLines("codex", [
      JSON.stringify({ type: "session_meta", payload: { session_id: UUID, cwd: "/tmp/beta" } }),
    ]);

    assert.equal(facts.nativeSessionId, UUID);
  });

  it("does not treat a tool result carrier as the first human turn", () => {
    const facts = foldLines("claude", [
      claudeRecord({
        type: "user",
        cwd: "/tmp/alpha",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
      claudeRecord({
        type: "user",
        cwd: "/tmp/alpha",
        message: { role: "user", content: "the real prompt" },
      }),
    ]);

    assert.equal(facts.firstUserMessage, "the real prompt");
  });

  it("survives a malformed line without losing what it already read", () => {
    const facts = foldLines("claude", [
      claudeRecord({ type: "user", cwd: "/tmp/alpha", message: { role: "user", content: "hi" } }),
      "{ this is not json",
    ]);

    assert.equal(facts.cwd, "/tmp/alpha");
    assert.equal(facts.firstUserMessage, "hi");
  });
});

describe("thread title", () => {
  it("uses the first user message when there is no summary", () => {
    const facts = {
      nativeSessionId: null,
      cwd: "/tmp/alpha",
      summary: null,
      firstUserMessage: "add a health endpoint",
    };
    assert.equal(importThreadTitle({ facts, provider: "claude" }), "add a health endpoint");
  });

  it("clips a long first message to the title budget", () => {
    const facts = {
      nativeSessionId: null,
      cwd: "/tmp/alpha",
      summary: null,
      firstUserMessage: "x".repeat(500),
    };
    const title = importThreadTitle({ facts, provider: "claude" });
    assert.equal(title.length, IMPORT_TITLE_MAX_CHARS + 1);
    assert.isTrue(title.endsWith("…"));
  });

  it("names the provider when the session yielded nothing to name it after", () => {
    const facts = { nativeSessionId: null, cwd: null, summary: null, firstUserMessage: null };
    assert.equal(importThreadTitle({ facts, provider: "codex" }), "Imported Codex session");
  });

  it("lets the caller override everything", () => {
    const facts = {
      nativeSessionId: null,
      cwd: null,
      summary: "a summary",
      firstUserMessage: "a message",
    };
    assert.equal(importThreadTitle({ facts, provider: "claude", requested: " chosen " }), "chosen");
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
