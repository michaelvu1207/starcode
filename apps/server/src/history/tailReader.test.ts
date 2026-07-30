// @effect-diagnostics nodeBuiltinImport:off - writes real fixture files, because
// the thing under test is byte offsets and chunk boundaries in a real file.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  readSessionHead,
  readSessionOpening,
  readSessionStats,
  readSessionTail,
  readSessionTitleTail,
} from "./tailReader.ts";

const withFixture = async (
  contents: string,
  use: (path: string) => Promise<void>,
): Promise<void> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-history-tail-"));
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

const aiTitle = (title: string): string => JSON.stringify({ type: "ai-title", aiTitle: title });

describe("readSessionTail", () => {
  it("serves the newest entries oldest-first", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => claudeUser(`message ${index}`));
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const tail = await readSessionTail({ path, provider: "claude", limit: 3 });
      // Newest three, rendered in reading order so a preview can show them
      // with the newest at the bottom.
      expect(tail.entries.map((entry) => entry.text)).toEqual([
        "message 7",
        "message 8",
        "message 9",
      ]);
      // The scan stopped short of the top, which is what tells a preview there
      // is history it is not showing.
      expect(tail.oldestExamined).toBeGreaterThan(0);
    });
  });

  it("reassembles records that straddle a chunk boundary", async () => {
    // A 4 KB chunk against ~1 KB records guarantees records straddle the
    // boundary, which is the case the carry buffer exists for.
    const lines = Array.from({ length: 40 }, (_, index) =>
      claudeUser(`m${index}-${"x".repeat(1_000)}`),
    );
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const tail = await readSessionTail({
        path,
        provider: "claude",
        limit: 6,
        chunkBytes: 4_096,
      });
      expect(tail.entries.map((entry) => entry.text.slice(0, entry.text.indexOf("-")))).toEqual([
        "m34",
        "m35",
        "m36",
        "m37",
        "m38",
        "m39",
      ]);
    });
  });

  it("skips malformed and unrenderable lines without failing", async () => {
    const contents = [
      claudeUser("first"),
      "{ this is not json",
      JSON.stringify({ type: "mode", mode: "normal" }),
      "",
      claudeAssistant("second"),
      '{"truncated": ',
    ].join("\n");
    await withFixture(contents, async (path) => {
      const tail = await readSessionTail({ path, provider: "claude", limit: 10 });
      expect(tail.entries.map((entry) => entry.text)).toEqual(["first", "second"]);
    });
  });

  it("reaches the top of a session it can read whole", async () => {
    await withFixture(`${claudeUser("only")}\n`, async (path) => {
      const tail = await readSessionTail({ path, provider: "claude", limit: 10 });
      expect(tail.entries.map((entry) => entry.text)).toEqual(["only"]);
      expect(tail.oldestExamined).toEqual(0);
    });
  });

  it("handles an empty file and one with no renderable records", async () => {
    await withFixture("", async (path) => {
      expect((await readSessionTail({ path, provider: "claude", limit: 10 })).entries).toEqual([]);
    });
    await withFixture(`${JSON.stringify({ type: "mode" })}\n`, async (path) => {
      expect((await readSessionTail({ path, provider: "claude", limit: 10 })).entries).toEqual([]);
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
      const tail = await readSessionTail({ path, provider: "codex", limit: 10 });
      expect(tail.entries.map((entry) => [entry.role, entry.text, entry.toolCalls])).toEqual([
        ["user", "hello", []],
        ["assistant", "", ["shell"]],
        ["assistant", "done", []],
      ]);
    });
  });

  it("returns a short page rather than a slow one once it has something to show", async () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      claudeUser(`m${index}-${"x".repeat(1_500)}`),
    );
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const tail = await readSessionTail({
        path,
        provider: "claude",
        limit: 80,
        chunkBytes: 2_048,
        maxPageBytes: 4_096,
      });
      expect(tail.entries.length).toBeGreaterThan(0);
      expect(tail.entries.length).toBeLessThan(40);
    });
  });

  it("keeps reading past the soft budget while it has nothing to show", async () => {
    // A long run of records that render to nothing, then one that does - the
    // 638 MB image session in miniature.
    const dead = Array.from({ length: 30 }, () =>
      JSON.stringify({ type: "file-history-snapshot", blob: "y".repeat(1_000) }),
    );
    await withFixture(`${[claudeUser("buried"), ...dead].join("\n")}\n`, async (path) => {
      const tail = await readSessionTail({
        path,
        provider: "claude",
        limit: 10,
        chunkBytes: 1_024,
        maxPageBytes: 2_048,
        hardMaxPageBytes: 1_000_000,
      });
      expect(tail.entries.map((entry) => entry.text)).toEqual(["buried"]);
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
        aiTitle: null,
      });
    });
  });

  it("picks up a title that sits within the head", async () => {
    await withFixture(`${[aiTitle("early name"), claudeUser("go")].join("\n")}\n`, async (path) => {
      expect((await readSessionHead({ path, provider: "claude" })).aiTitle).toEqual("early name");
    });
  });

  it("takes the opening message from a compacted Codex rollout", async () => {
    // Compaction folds early history into a summary and keeps the originals in
    // `replacement_history`, in the response-item shape rather than the
    // `event_msg` shape the rest of the reader speaks.
    const contents = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
      JSON.stringify({
        type: "compacted",
        payload: {
          message: "…summary…",
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "the real opening" }],
            },
          ],
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "later" } }),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      expect((await readSessionHead({ path, provider: "codex" })).snippet).toEqual(
        "the real opening",
      );
    });
  });

  it("gives up gracefully when the budget runs out before a user message", async () => {
    // Claude's budget is 64 KB; a preamble larger than that yields a row with
    // no snippet rather than an unbounded read.
    const filler = Array.from({ length: 40 }, () =>
      JSON.stringify({ type: "attachment", blob: "y".repeat(2_000) }),
    ).join("\n");
    await withFixture(`${filler}\n${claudeUser("never reached")}\n`, async (path) => {
      expect((await readSessionHead({ path, provider: "claude" })).snippet).toBeNull();
    });
  });

  it("survives a session whose first line is truncated", async () => {
    await withFixture(`{"type":"user","mess\n${claudeUser("recovered")}\n`, async (path) => {
      expect((await readSessionHead({ path, provider: "claude" })).snippet).toEqual("recovered");
    });
  });
});

describe("readSessionTitleTail", () => {
  it("takes the last title in the file, not the first", async () => {
    // Claude appends a fresh `ai-title` every time it revises its idea of what
    // the session is about, so the earliest one is a stale guess.
    const contents = [
      aiTitle("first guess"),
      claudeUser("work"),
      aiTitle("second guess"),
      claudeAssistant("ok"),
      aiTitle("what it actually became"),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      expect(await readSessionTitleTail({ path })).toEqual("what it actually became");
    });
  });

  it("finds a title that sits behind a wall of large records", async () => {
    const filler = Array.from({ length: 20 }, () =>
      JSON.stringify({ type: "file-history-snapshot", blob: "z".repeat(2_000) }),
    ).join("\n");
    await withFixture(`${aiTitle("buried")}\n${filler}\n`, async (path) => {
      expect(await readSessionTitleTail({ path, chunkBytes: 1_024 })).toEqual("buried");
    });
  });

  it("reports nothing for a session that never named itself", async () => {
    await withFixture(`${claudeUser("untitled work")}\n`, async (path) => {
      expect(await readSessionTitleTail({ path })).toBeNull();
    });
  });

  it("stops at its budget rather than reading the whole file", async () => {
    const filler = Array.from({ length: 40 }, () =>
      JSON.stringify({ type: "file-history-snapshot", blob: "z".repeat(1_000) }),
    ).join("\n");
    await withFixture(`${aiTitle("out of reach")}\n${filler}\n`, async (path) => {
      expect(
        await readSessionTitleTail({ path, chunkBytes: 1_024, budgetBytes: 4_096 }),
      ).toBeNull();
    });
  });
});

describe("readSessionOpening", () => {
  it("returns the first human turn with the offset that places it", async () => {
    const preamble = JSON.stringify({ type: "mode", mode: "normal" });
    const contents = [preamble, claudeUser("the opening"), claudeUser("a later one")].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      const opening = await readSessionOpening({ path, provider: "claude" });
      expect(opening?.text).toEqual("the opening");
      expect(opening?.offset).toEqual(preamble.length + 1);
    });
  });

  it("ignores a tool-result carrier wearing the user role", async () => {
    const contents = [
      JSON.stringify({
        type: "user",
        cwd: "/w",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
      claudeUser("the real opening"),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      expect((await readSessionOpening({ path, provider: "claude" }))?.text).toEqual(
        "the real opening",
      );
    });
  });

  it("recovers a compacted Codex opening", async () => {
    const contents = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
      JSON.stringify({
        type: "compacted",
        payload: {
          replacement_history: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "what got folded away" }],
            },
          ],
        },
      }),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      expect((await readSessionOpening({ path, provider: "codex" }))?.text).toEqual(
        "what got folded away",
      );
    });
  });

  it("reads an opening that straddles a chunk boundary", async () => {
    const filler = Array.from({ length: 6 }, () =>
      JSON.stringify({ type: "mode", blob: "q".repeat(400) }),
    ).join("\n");
    await withFixture(`${filler}\n${claudeUser("across the seam")}\n`, async (path) => {
      expect(
        (await readSessionOpening({ path, provider: "claude", chunkBytes: 512 }))?.text,
      ).toEqual("across the seam");
    });
  });

  it("returns nothing for a session with no human turn inside the budget", async () => {
    await withFixture(`${claudeAssistant("only the model spoke")}\n`, async (path) => {
      expect(await readSessionOpening({ path, provider: "claude" })).toBeNull();
    });
  });
});

describe("readSessionStats", () => {
  it("counts renderable messages and reports when the session began", async () => {
    const contents = [
      JSON.stringify({
        type: "user",
        cwd: "/w",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { role: "user", content: "one" },
      }),
      JSON.stringify({ type: "mode", mode: "normal" }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T10:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "two" }] },
      }),
      claudeUser("three"),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      expect(await readSessionStats({ path, provider: "claude" })).toEqual({
        messageCount: 3,
        startedAt: "2026-07-01T10:00:00.000Z",
      });
    });
  });

  it("does not count a record that renders to tool calls alone", async () => {
    // "Messages" means what a reader would count, not what the file contains.
    const contents = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      expect((await readSessionStats({ path, provider: "codex" })).messageCount).toEqual(1);
    });
  });

  it("counts a final line that has no trailing newline", async () => {
    await withFixture([claudeUser("a"), claudeUser("b")].join("\n"), async (path) => {
      expect((await readSessionStats({ path, provider: "claude" })).messageCount).toEqual(2);
    });
  });

  it("reports an unknown count rather than a partial one past its budget", async () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      claudeUser(`m${index}-${"x".repeat(500)}`),
    );
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const stats = await readSessionStats({
        path,
        provider: "claude",
        chunkBytes: 1_024,
        budgetBytes: 2_048,
      });
      expect(stats.messageCount).toBeNull();
    });
  });
});
