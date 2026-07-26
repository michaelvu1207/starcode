// @effect-diagnostics nodeBuiltinImport:off - builds a synthetic home directory and
// inspects the cache file the store owns, both of which are real filesystem boundaries.
// @effect-diagnostics preferSchemaOverJson:off - asserts and hand-writes the cache's
// on-disk bytes, which is the one thing a schema round-trip would hide.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeCliUsageStore } from "./CliUsageStore.ts";

/** A home directory laid out the way the two CLIs lay theirs out. */
const makeHome = (): Effect.Effect<{ homeDir: string; cachePath: string }> =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-usage-store-"));
    return { homeDir: NodePath.join(root, "home"), cachePath: NodePath.join(root, "cache.json") };
  });

const writeClaudeSession = (
  homeDir: string,
  relative: string,
  records: ReadonlyArray<unknown>,
): Effect.Effect<string> =>
  Effect.promise(async () => {
    const path = NodePath.join(homeDir, ".claude", "projects", relative);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(
      path,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    return path;
  });

const assistantRecord = (id: string, outputTokens: number, model = "claude-opus-5"): unknown => ({
  type: "assistant",
  timestamp: "2026-07-20T12:00:00.000Z",
  requestId: `req_${id}`,
  message: { id: `msg_${id}`, model, usage: { output_tokens: outputTokens } },
});

const readFile = (path: string): Effect.Effect<string> =>
  Effect.promise(() => NodeFSP.readFile(path, "utf8"));

const writeFile = (path: string, contents: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await NodeFSP.writeFile(path, contents, "utf8");
  });

const statOf = (path: string): Effect.Effect<{ mtimeMs: number; size: number }> =>
  Effect.promise(async () => {
    const stats = await NodeFSP.stat(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  });

describe("CliUsageStore", () => {
  it.effect("answers immediately with a scanning placeholder before the first pass lands", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [assistantRecord("1", 10)]);
      const store = makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" });

      const first = yield* store.current;
      assert.strictEqual(first.status, "scanning");
      assert.isNull(first.computedAt);
      assert.lengthOf(first.providers, 0);
    }),
  );

  it.effect("reports the store's spend once a pass completes", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [
        assistantRecord("1", 1_000_000),
      ]);
      const store = makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" });

      yield* store.refresh;
      const snapshot = yield* store.current;

      assert.strictEqual(snapshot.status, "ready");
      assert.isNotNull(snapshot.computedAt);
      assert.strictEqual(snapshot.filesScanned, 1);
      // 1M output tokens of claude-opus-5 at $25/M.
      assert.strictEqual(Math.round(snapshot.totals.costUsd * 100) / 100, 25);
    }),
  );

  it.effect("counts subagent transcripts nested under a session, not just top-level files", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [assistantRecord("1", 1_000)]);
      yield* writeClaudeSession(homeDir, "project-a/session/subagents/agent-x.jsonl", [
        assistantRecord("2", 2_000),
      ]);
      const store = makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" });

      yield* store.refresh;
      const snapshot = yield* store.current;

      assert.strictEqual(snapshot.filesScanned, 2);
      assert.strictEqual(snapshot.totals.outputTokens, 3_000);
    }),
  );

  it.effect("writes a cache carrying the parsed rows", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      const sessionPath = yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [
        assistantRecord("1", 1_000),
      ]);
      yield* makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" }).refresh;

      const cache: unknown = JSON.parse(yield* readFile(cachePath));
      const entry = (
        cache as { files: Record<string, { k: ReadonlyArray<ReadonlyArray<unknown>> }> }
      ).files[sessionPath];
      assert.isDefined(entry);
      assert.strictEqual(entry?.k[0]?.[0], "msg_1:req_1");
      assert.strictEqual(entry?.k[0]?.[4], 1_000);
    }),
  );

  it.effect("re-uses a cached parse instead of re-reading an unchanged file", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      const sessionPath = yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [
        assistantRecord("1", 1_000),
      ]);
      const stats = yield* statOf(sessionPath);

      // A hand-written cache whose rows disagree with the file they claim to
      // describe. Only a store that trusted the cache can report 4,242.
      yield* writeFile(
        cachePath,
        JSON.stringify({
          version: 1,
          files: {
            [sessionPath]: {
              p: "claude",
              m: stats.mtimeMs,
              s: stats.size,
              k: [["cached:row", "2026-07-20", "claude-opus-5", 0, 4_242, 0, 0, 0]],
              b: [],
            },
          },
        }),
      );

      const store = makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" });
      yield* store.refresh;
      assert.strictEqual((yield* store.current).totals.outputTokens, 4_242);
    }),
  );

  it.effect("re-reads a file whose size changed", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [assistantRecord("1", 1_000)]);
      const store = makeCliUsageStore({
        homeDir,
        cachePath,
        refreshIntervalMs: 0,
        timeZone: "UTC",
      });
      yield* store.refresh;

      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [
        assistantRecord("1", 1_000),
        assistantRecord("2", 500),
      ]);
      yield* store.refresh;

      assert.strictEqual((yield* store.current).totals.outputTokens, 1_500);
    }),
  );

  it.effect("stops counting a session file that was deleted", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      const path = yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [
        assistantRecord("1", 1_000),
      ]);
      const store = makeCliUsageStore({
        homeDir,
        cachePath,
        refreshIntervalMs: 0,
        timeZone: "UTC",
      });
      yield* store.refresh;

      yield* Effect.promise(() => NodeFSP.rm(path));
      yield* store.refresh;

      const snapshot = yield* store.current;
      assert.strictEqual(snapshot.filesScanned, 0);
      assert.strictEqual(snapshot.totals.costUsd, 0);
    }),
  );

  it.effect("discards a cache written under a different version rather than trusting it", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [assistantRecord("1", 4_000)]);
      yield* writeFile(
        cachePath,
        JSON.stringify({
          version: 999,
          files: { "/nonsense": { p: "claude", m: 1, s: 1, k: [], b: [] } },
        }),
      );

      const store = makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" });
      yield* store.refresh;
      assert.strictEqual((yield* store.current).totals.outputTokens, 4_000);
    }),
  );

  it.effect("survives an unreadable cache file", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [assistantRecord("1", 7)]);
      yield* writeFile(cachePath, "{ not json");

      const store = makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" });
      yield* store.refresh;
      assert.strictEqual((yield* store.current).status, "ready");
    }),
  );

  it.effect("reports a machine with no CLI stores as ready and empty, not failed", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* Effect.promise(() => NodeFSP.mkdir(homeDir, { recursive: true }));
      const store = makeCliUsageStore({ homeDir, cachePath, timeZone: "UTC" });

      yield* store.refresh;
      const snapshot = yield* store.current;

      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.filesScanned, 0);
      assert.lengthOf(snapshot.providers, 0);
    }),
  );

  it.effect("serves the completed aggregate rather than rescanning inside the refresh window", () =>
    Effect.gen(function* () {
      const { homeDir, cachePath } = yield* makeHome();
      yield* writeClaudeSession(homeDir, "project-a/session.jsonl", [assistantRecord("1", 1_000)]);
      const store = makeCliUsageStore({
        homeDir,
        cachePath,
        refreshIntervalMs: 10 * 60_000,
        timeZone: "UTC",
      });
      yield* store.refresh;

      yield* writeClaudeSession(homeDir, "project-b/session.jsonl", [assistantRecord("2", 9_999)]);
      yield* store.refresh;

      assert.strictEqual((yield* store.current).totals.outputTokens, 1_000);
    }),
  );
});
