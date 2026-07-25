// @effect-diagnostics nodeBuiltinImport:off - writes real fixture files, because
// the thing under test is byte offsets and chunk boundaries in a real file.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readSessionHead, readTranscriptTail } from "./tailReader.ts";

const withFixture = async (
  contents: string,
  use: (path: string) => Promise<void>,
): Promise<void> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-history-tail-"));
  const path = NodePath.join(root, "session.jsonl");
  try {
    await NodeFSP.writeFile(path, contents, "utf8");
    await use(path);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const claudeUser = (text: string): string =>
  JSON.stringify({ type: "user", cwd: "/w", message: { role: "user", content: text } });

const claudeAssistant = (text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("readTranscriptTail", () => {
  it("serves the newest entries oldest-first within the page", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => claudeUser(`message ${index}`));
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const tail = await readTranscriptTail({ path, provider: "claude", before: null, limit: 3 });
      // Newest three, but rendered in reading order so the viewer can append
      // them with the newest at the bottom.
      expect(tail.entries.map((entry) => entry.text)).toEqual([
        "message 7",
        "message 8",
        "message 9",
      ]);
      expect(tail.hasMore).toBe(true);
    });
  });

  it("pages backwards without dropping or repeating an entry", async () => {
    const lines = Array.from({ length: 25 }, (_, index) => claudeUser(`m${index}`));
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const seen: string[] = [];
      let before: number | null = null;
      for (let page = 0; page < 10; page += 1) {
        const tail: Awaited<ReturnType<typeof readTranscriptTail>> = await readTranscriptTail({
          path,
          provider: "claude",
          before,
          limit: 4,
        });
        seen.unshift(...tail.entries.map((entry) => entry.text));
        if (!tail.hasMore) break;
        before = tail.nextBefore;
      }
      expect(seen).toEqual(lines.map((_, index) => `m${index}`));
    });
  });

  it("pages across a chunk boundary that falls inside a record", async () => {
    // A 4 KB chunk against ~1 KB records guarantees records straddle the
    // boundary, which is the case the carry buffer exists for.
    const lines = Array.from({ length: 40 }, (_, index) =>
      claudeUser(`m${index}-${"x".repeat(1_000)}`),
    );
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const seen: string[] = [];
      let before: number | null = null;
      for (let page = 0; page < 40; page += 1) {
        const tail: Awaited<ReturnType<typeof readTranscriptTail>> = await readTranscriptTail({
          path,
          provider: "claude",
          before,
          limit: 3,
          chunkBytes: 4_096,
        });
        seen.unshift(...tail.entries.map((entry) => entry.text.slice(0, entry.text.indexOf("-"))));
        if (!tail.hasMore) break;
        before = tail.nextBefore;
      }
      expect(seen).toEqual(lines.map((_, index) => `m${index}`));
      expect(new Set(seen).size).toEqual(40);
    });
  });

  it("reports offsets that round-trip as a cursor", async () => {
    await withFixture(
      `${[claudeUser("a"), claudeUser("b"), claudeUser("c")].join("\n")}\n`,
      async (path) => {
        const all = await readTranscriptTail({ path, provider: "claude", before: null, limit: 10 });
        const second = all.entries[1];
        expect(second).toBeDefined();
        const older = await readTranscriptTail({
          path,
          provider: "claude",
          before: second?.offset ?? 0,
          limit: 10,
        });
        // `before` is exclusive, so paging from the second entry's offset yields
        // only what precedes it.
        expect(older.entries.map((entry) => entry.text)).toEqual(["a"]);
      },
    );
  });

  it("skips malformed and unrenderable lines without failing the page", async () => {
    const contents = [
      claudeUser("first"),
      "{ this is not json",
      JSON.stringify({ type: "mode", mode: "normal" }),
      "",
      claudeAssistant("second"),
      '{"truncated": ',
    ].join("\n");
    await withFixture(contents, async (path) => {
      const tail = await readTranscriptTail({ path, provider: "claude", before: null, limit: 10 });
      expect(tail.entries.map((entry) => entry.text)).toEqual(["first", "second"]);
      expect(tail.hasMore).toBe(false);
    });
  });

  it("handles an empty file and a file with no renderable records", async () => {
    await withFixture("", async (path) => {
      const tail = await readTranscriptTail({ path, provider: "claude", before: null, limit: 10 });
      expect(tail.entries).toEqual([]);
      expect(tail.hasMore).toBe(false);
      expect(tail.nextBefore).toBeNull();
    });
    await withFixture(`${JSON.stringify({ type: "mode" })}\n`, async (path) => {
      const tail = await readTranscriptTail({ path, provider: "claude", before: null, limit: 10 });
      expect(tail.entries).toEqual([]);
      expect(tail.hasMore).toBe(false);
    });
  });

  it("stops when it has reached the front of the file", async () => {
    await withFixture(`${claudeUser("only")}\n`, async (path) => {
      const tail = await readTranscriptTail({ path, provider: "claude", before: null, limit: 10 });
      expect(tail.entries.map((entry) => entry.text)).toEqual(["only"]);
      expect(tail.hasMore).toBe(false);
      expect(tail.nextBefore).toBeNull();
    });
  });

  it("reads a Codex rollout tail", async () => {
    const contents = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "done" } }),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      const tail = await readTranscriptTail({ path, provider: "codex", before: null, limit: 10 });
      expect(tail.entries.map((entry) => [entry.role, entry.text, entry.toolCalls])).toEqual([
        ["user", "hello", []],
        ["assistant", "", ["shell"]],
        ["assistant", "done", []],
      ]);
    });
  });
});

describe("readSessionHead", () => {
  it("reads the project and snippet past the opening metadata", async () => {
    const contents = [
      JSON.stringify({ type: "last-prompt", leafUuid: "x" }),
      JSON.stringify({ type: "mode", mode: "normal" }),
      claudeUser("the opening prompt"),
      claudeUser("a later prompt that must not win"),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      expect(await readSessionHead({ path, provider: "claude" })).toEqual({
        projectPath: "/w",
        snippet: "the opening prompt",
      });
    });
  });

  it("gives up gracefully when the budget runs out before a user message", async () => {
    // Claude's budget is 64 KB; a preamble larger than that yields a row with
    // no snippet rather than an unbounded read.
    const filler = Array.from({ length: 40 }, () =>
      JSON.stringify({ type: "attachment", blob: "y".repeat(2_000) }),
    ).join("\n");
    await withFixture(`${filler}\n${claudeUser("never reached")}\n`, async (path) => {
      const head = await readSessionHead({ path, provider: "claude" });
      expect(head.snippet).toBeNull();
    });
  });

  it("survives a session whose first line is truncated", async () => {
    await withFixture(`{"type":"user","mess\n${claudeUser("recovered")}\n`, async (path) => {
      expect((await readSessionHead({ path, provider: "claude" })).snippet).toEqual("recovered");
    });
  });
});

describe("readTranscriptTail page budgets", () => {
  it("returns a short page rather than a slow one once it has something to show", async () => {
    // Records padded so a 4 KB soft budget is spent well before the limit.
    const lines = Array.from({ length: 40 }, (_, index) =>
      claudeUser(`m${index}-${"x".repeat(1_500)}`),
    );
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const tail = await readTranscriptTail({
        path,
        provider: "claude",
        before: null,
        limit: 80,
        chunkBytes: 2_048,
        maxPageBytes: 4_096,
      });
      expect(tail.entries.length).toBeGreaterThan(0);
      expect(tail.entries.length).toBeLessThan(40);
      // Short, but honest: the cursor continues exactly where it stopped.
      expect(tail.hasMore).toBe(true);
      expect(tail.nextBefore).not.toBeNull();
    });
  });

  it("keeps reading past the soft budget while the page is still empty", async () => {
    // A long run of records that render to nothing, then one that does - the
    // 638 MB image session in miniature.
    const dead = Array.from({ length: 30 }, () =>
      JSON.stringify({ type: "file-history-snapshot", blob: "y".repeat(1_000) }),
    );
    await withFixture(`${[claudeUser("buried"), ...dead].join("\n")}\n`, async (path) => {
      const tail = await readTranscriptTail({
        path,
        provider: "claude",
        before: null,
        limit: 10,
        chunkBytes: 1_024,
        maxPageBytes: 2_048,
        hardMaxPageBytes: 1_000_000,
      });
      expect(tail.entries.map((entry) => entry.text)).toEqual(["buried"]);
    });
  });

  it("still advances the cursor when one record is larger than the whole budget", async () => {
    // Without a forced step the client would refetch the same bytes forever.
    const huge = JSON.stringify({ type: "file-history-snapshot", blob: "z".repeat(50_000) });
    await withFixture(`${claudeUser("older")}\n${huge}\n`, async (path) => {
      const tail = await readTranscriptTail({
        path,
        provider: "claude",
        before: null,
        limit: 10,
        chunkBytes: 1_024,
        maxPageBytes: 2_048,
        hardMaxPageBytes: 2_048,
      });
      expect(tail.entries).toEqual([]);
      expect(tail.hasMore).toBe(true);
      const next = tail.nextBefore ?? Number.MAX_SAFE_INTEGER;

      const older = await readTranscriptTail({
        path,
        provider: "claude",
        before: next,
        limit: 10,
        chunkBytes: 1_024,
        maxPageBytes: 2_048,
        hardMaxPageBytes: 2_048,
      });
      // Progress: the second request reads strictly earlier bytes.
      expect(older.nextBefore === null || older.nextBefore < next).toBe(true);
    });
  });
});
