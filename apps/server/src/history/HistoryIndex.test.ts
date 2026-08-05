// @effect-diagnostics nodeBuiltinImport:off - builds a synthetic home directory,
// because discovery is exactly the thing under test.
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { makeHistoryIndex, type HistoryIndexShape } from "./HistoryIndex.ts";
import { historySessionIdForPath } from "./paths.ts";

const claudeUser = (text: string, cwd: string): string =>
  JSON.stringify({ type: "user", cwd, message: { role: "user", content: text } });

const claudeSubagentMeta = (toolUseId: string): string =>
  JSON.stringify({
    agentType: "Explore",
    description: "Inspect the implementation",
    model: "opus",
    spawnDepth: 1,
    toolUseId,
  });

const CODEX_ROLLOUT = `${[
  JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/beta" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "ship" } }),
].join("\n")}\n`;

const writeFile = (path: string, contents: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents, "utf8");
  });

interface HomeFixture {
  readonly home: string;
  readonly index: HistoryIndexShape;
  readonly path: (relative: string) => string;
}

/**
 * A synthetic home directory shaped like the real stores: a Claude project
 * directory with a `memory/` subdirectory and a session-named `subagents/`
 * directory beside the sessions, and a date-nested Codex tree with a stray
 * `.DS_Store`. All three of those extras exist to be excluded.
 */
const withHome = <A, E>(
  use: (fixture: HomeFixture) => Effect.Effect<A, E>,
  options?: { readonly debounceMs?: number },
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-history-home-")),
    );
    const path = (relative: string) => NodePath.join(home, relative);

    return yield* Effect.gen(function* () {
      yield* writeFile(
        path(".claude/projects/-tmp-alpha/session-one.jsonl"),
        `${claudeUser("first prompt", "/tmp/alpha")}\n`,
      );
      yield* writeFile(
        path(".claude/projects/-tmp-alpha/session-two.jsonl"),
        `${claudeUser("second prompt", "/tmp/alpha")}\n`,
      );
      yield* writeFile(path(".claude/projects/-tmp-alpha/memory/MEMORY.md"), "# notes\n");
      yield* writeFile(
        path(".claude/projects/-tmp-alpha/session-two/subagents/agent-aux.jsonl"),
        `${claudeUser("subagent work", "/tmp/alpha")}\n`,
      );
      yield* writeFile(
        path(".claude/projects/-tmp-alpha/session-two/subagents/agent-aux.meta.json"),
        claudeSubagentMeta("toolu_aux"),
      );
      yield* writeFile(
        path(".codex/sessions/2026/07/20/rollout-2026-07-20T10-00-00-abc.jsonl"),
        CODEX_ROLLOUT,
      );
      yield* writeFile(path(".codex/sessions/.DS_Store"), "junk");

      const index = makeHistoryIndex({ homeDir: home, debounceMs: options?.debounceMs ?? 0 });
      return yield* use({ home, index, path });
    }).pipe(
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }))),
    );
  });

describe("HistoryIndex discovery", () => {
  it.effect("finds sessions from both stores and nothing else", () =>
    withHome(({ index }) =>
      Effect.gen(function* () {
        const snapshot = yield* index.snapshot();
        const names = snapshot.entries.map((entry) => NodePath.basename(entry.path)).sort();
        expect(names).toEqual([
          "rollout-2026-07-20T10-00-00-abc.jsonl",
          "session-one.jsonl",
          "session-two.jsonl",
        ]);
        // The subagent transcript and the memory directory are both excluded:
        // one is a fragment of another session, the other is not a session.
        expect(names).not.toContain("agent-aux.jsonl");
        expect(snapshot.entries.filter((entry) => entry.provider === "codex")).toHaveLength(1);
      }),
    ),
  );

  it.effect("indexes a Claude subagent for resolution without listing it as a session", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        const agentPath = path(".claude/projects/-tmp-alpha/session-two/subagents/agent-aux.jsonl");
        const snapshot = yield* index.snapshot();
        expect(snapshot.entries.some((entry) => entry.path === agentPath)).toBe(false);

        const resolved = yield* index.resolve(historySessionIdForPath(agentPath));
        expect(resolved).toMatchObject({
          kind: "subagent",
          path: agentPath,
          parentNativeSessionId: "session-two",
          agentRunId: "aux",
          claudeSubagentMetadata: {
            toolUseId: "toolu_aux",
            agentType: "Explore",
            description: "Inspect the implementation",
            model: "opus",
            spawnDepth: 1,
          },
        });
      }),
    ),
  );

  it.effect("links a Claude subagent only when parent, task, and launch tool all match", () =>
    withHome(({ index }) =>
      Effect.gen(function* () {
        const exact = yield* index.findClaudeSubagent({
          parentNativeSessionId: "session-two",
          agentRunId: "aux",
          launchToolUseId: "toolu_aux",
        });
        expect(exact?.kind).toBe("subagent");

        for (const mismatch of [
          {
            parentNativeSessionId: "another-session",
            agentRunId: "aux",
            launchToolUseId: "toolu_aux",
          },
          {
            parentNativeSessionId: "session-two",
            agentRunId: "another-agent",
            launchToolUseId: "toolu_aux",
          },
          {
            parentNativeSessionId: "session-two",
            agentRunId: "aux",
            launchToolUseId: "toolu_another",
          },
        ]) {
          expect(yield* index.findClaudeSubagent(mismatch)).toBeNull();
        }
      }),
    ),
  );

  it.effect("refuses missing, malformed, and ambiguous Claude subagent metadata", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        yield* writeFile(
          path(".claude/projects/-tmp-alpha/session-two/subagents/agent-missing.jsonl"),
          `${claudeUser("missing meta", "/tmp/alpha")}\n`,
        );
        yield* writeFile(
          path(".claude/projects/-tmp-alpha/session-two/subagents/agent-malformed.jsonl"),
          `${claudeUser("bad meta", "/tmp/alpha")}\n`,
        );
        yield* writeFile(
          path(".claude/projects/-tmp-alpha/session-two/subagents/agent-malformed.meta.json"),
          "{not json",
        );
        for (const agentRunId of ["missing", "malformed"]) {
          expect(
            yield* index.findClaudeSubagent({
              parentNativeSessionId: "session-two",
              agentRunId,
              launchToolUseId: "toolu_aux",
            }),
          ).toBeNull();
        }

        yield* writeFile(
          path(".claude/projects/-tmp-copy/session-two/subagents/agent-aux.jsonl"),
          `${claudeUser("copied transcript", "/tmp/copy")}\n`,
        );
        yield* writeFile(
          path(".claude/projects/-tmp-copy/session-two/subagents/agent-aux.meta.json"),
          claudeSubagentMeta("toolu_aux"),
        );
        expect(
          yield* index.findClaudeSubagent({
            parentNativeSessionId: "session-two",
            agentRunId: "aux",
            launchToolUseId: "toolu_aux",
          }),
        ).toBeNull();
      }),
    ),
  );

  it.effect("revalidates an existing Claude subagent directory", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        expect(
          yield* index.findClaudeSubagent({
            parentNativeSessionId: "session-two",
            agentRunId: "later",
            launchToolUseId: "toolu_later",
          }),
        ).toBeNull();
        yield* writeFile(
          path(".claude/projects/-tmp-alpha/session-two/subagents/agent-later.jsonl"),
          `${claudeUser("later work", "/tmp/alpha")}\n`,
        );
        yield* writeFile(
          path(".claude/projects/-tmp-alpha/session-two/subagents/agent-later.meta.json"),
          claudeSubagentMeta("toolu_later"),
        );
        expect(
          yield* index.findClaudeSubagent({
            parentNativeSessionId: "session-two",
            agentRunId: "later",
            launchToolUseId: "toolu_later",
          }),
        ).toMatchObject({ kind: "subagent", agentRunId: "later" });
      }),
    ),
  );

  it.effect("uses an explicit Codex home for transcript lookup", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-history-home-")),
      );
      const codexHome = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-home-")),
      );
      const rolloutPath = NodePath.join(
        codexHome,
        "sessions/2026/07/20/rollout-2026-07-20T10-00-00-abc.jsonl",
      );

      yield* Effect.gen(function* () {
        yield* writeFile(rolloutPath, CODEX_ROLLOUT);
        const index = makeHistoryIndex({ homeDir: home, codexHome, debounceMs: 0 });
        const snapshot = yield* index.snapshot();
        expect(snapshot.byId.get(historySessionIdForPath(rolloutPath))?.path).toEqual(rolloutPath);
      }).pipe(
        Effect.ensuring(
          Effect.promise(() =>
            Promise.all([
              NodeFSP.rm(home, { recursive: true, force: true }),
              NodeFSP.rm(codexHome, { recursive: true, force: true }),
            ]).then(() => undefined),
          ),
        ),
      );
    }),
  );

  it.effect("orders newest first", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const older = DateTime.toDateUtc(DateTime.makeUnsafe(nowMs - 60_000));
        yield* Effect.promise(() =>
          NodeFSP.utimes(path(".claude/projects/-tmp-alpha/session-one.jsonl"), older, older),
        );
        const snapshot = yield* index.snapshot();
        expect(NodePath.basename(snapshot.entries.at(-1)?.path ?? "")).toEqual("session-one.jsonl");
      }),
    ),
  );

  it.effect("survives a machine with no Codex installed", () =>
    withHome(({ index, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, ".codex"), { recursive: true, force: true }),
        );
        expect((yield* index.snapshot()).entries).toHaveLength(2);
      }),
    ),
  );

  it.effect("picks up a session written after the first build", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        expect((yield* index.snapshot()).entries).toHaveLength(3);
        yield* writeFile(
          path(".claude/projects/-tmp-alpha/session-three.jsonl"),
          `${claudeUser("third", "/tmp/alpha")}\n`,
        );
        expect((yield* index.snapshot()).entries).toHaveLength(4);
      }),
    ),
  );

  it.effect("does not rescan inside the debounce window", () =>
    withHome(
      ({ index, path }) =>
        Effect.gen(function* () {
          expect((yield* index.snapshot()).entries).toHaveLength(3);
          yield* writeFile(
            path(".claude/projects/-tmp-alpha/session-four.jsonl"),
            `${claudeUser("fourth", "/tmp/alpha")}\n`,
          );
          // Written, but the index was rebuilt moments ago: a strip that
          // expands and collapses repeatedly must not walk the store each time.
          expect((yield* index.snapshot()).entries).toHaveLength(3);
        }),
      { debounceMs: 60_000 },
    ),
  );
});

describe("HistoryIndex.resolve - the traversal guard", () => {
  it.effect("resolves an id the index minted", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        const sessionPath = path(".claude/projects/-tmp-alpha/session-one.jsonl");
        const resolved = yield* index.resolve(historySessionIdForPath(sessionPath));
        expect(resolved?.path).toEqual(sessionPath);
      }),
    ),
  );

  it.effect("refuses a well-formed id for a file outside the store", () =>
    withHome(({ index }) =>
      Effect.gen(function* () {
        // The id is syntactically perfect. It still resolves to nothing,
        // because the index only holds files it discovered under its own roots.
        expect(yield* index.resolve(historySessionIdForPath("/etc/passwd"))).toBeNull();
      }),
    ),
  );

  it.effect("refuses anything path-shaped before it ever looks", () =>
    withHome(({ index }) =>
      Effect.gen(function* () {
        for (const forged of [
          "../../../etc/passwd",
          "/etc/passwd",
          "..%2F..%2Fetc%2Fpasswd",
          "session-one.jsonl",
          "",
          "0".repeat(31),
        ]) {
          expect(yield* index.resolve(forged)).toBeNull();
        }
      }),
    ),
  );

  it.effect("refuses an id for a session that has been deleted", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        const sessionPath = path(".claude/projects/-tmp-alpha/session-one.jsonl");
        const id = historySessionIdForPath(sessionPath);
        expect(yield* index.resolve(id)).not.toBeNull();
        yield* Effect.promise(() => NodeFSP.rm(sessionPath));
        expect(yield* index.resolve(id)).toBeNull();
      }),
    ),
  );
});

describe("HistoryIndex.hydrate", () => {
  it.effect("fills in the project and snippet each provider reports", () =>
    withHome(({ index }) =>
      Effect.gen(function* () {
        const snapshot = yield* index.snapshot();
        const summaries = yield* index.hydrate(snapshot.entries);
        const byProject = new Map(summaries.map((item) => [item.projectPath, item]));

        const claude = byProject.get("/tmp/alpha");
        expect(claude?.projectLabel).toEqual("alpha");
        expect(claude?.snippet).toMatch(/prompt$/);

        // Codex's path says nothing about the project; the cwd can only come
        // from the file's own session_meta.
        const codex = byProject.get("/tmp/beta");
        expect(codex?.provider).toEqual("codex");
        expect(codex?.snippet).toEqual("ship");
        expect(codex?.projectLabel).toEqual("beta");
      }),
    ),
  );

  it.effect("reports mtime as the session's last activity", () =>
    withHome(({ index }) =>
      Effect.gen(function* () {
        const snapshot = yield* index.snapshot();
        const [summary] = yield* index.hydrate(snapshot.entries.slice(0, 1));
        expect(Date.parse(summary?.lastActivityAt ?? "")).toEqual(
          Math.floor(snapshot.entries[0]?.mtimeMs ?? -1),
        );
        expect(summary?.sizeBytes).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("still returns a row for a session it cannot summarise", () =>
    withHome(({ index, path }) =>
      Effect.gen(function* () {
        yield* writeFile(path(".claude/projects/-tmp-gamma/opaque.jsonl"), "not json at all\n");
        const snapshot = yield* index.snapshot();
        const target = snapshot.entries.find((entry) => entry.path.endsWith("opaque.jsonl"));
        expect(target).toBeDefined();
        const [summary] = yield* index.hydrate(target === undefined ? [] : [target]);
        expect(summary?.snippet).toBeNull();
        // A session you cannot summarise is still one you should be able to open.
        expect(summary?.id).toEqual(target?.id);
      }),
    ),
  );
});
