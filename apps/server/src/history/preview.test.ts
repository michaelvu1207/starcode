// @effect-diagnostics nodeBuiltinImport:off - writes real fixture files, because
// the join between a head read and a tail read is a byte-offset comparison.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readSessionPreview } from "./preview.ts";

const withFixture = async (
  contents: string,
  use: (path: string) => Promise<void>,
): Promise<void> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-history-preview-"));
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

describe("readSessionPreview", () => {
  it("shows how a long session opened and where it ended up", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => claudeUser(`m${index}`));
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const preview = await readSessionPreview({ path, provider: "claude", tailEntries: 3 });

      expect(preview.opening?.text).toEqual("m0");
      expect(preview.tail.map((entry) => entry.text)).toEqual(["m37", "m38", "m39"]);
      // The elision is the honest part: without it four entries would read as
      // a four-message session.
      expect(preview.gap).toBe(true);
    });
  });

  it("does not show a short session's opening twice", async () => {
    await withFixture(
      `${[claudeUser("a"), claudeUser("b"), claudeUser("c")].join("\n")}\n`,
      async (path) => {
        const preview = await readSessionPreview({ path, provider: "claude", tailEntries: 8 });

        // The tail already reaches the top, so the opening is not repeated
        // above it.
        expect(preview.opening).toBeNull();
        expect(preview.tail.map((entry) => entry.text)).toEqual(["a", "b", "c"]);
        expect(preview.gap).toBe(false);
      },
    );
  });

  it("reports no gap when the tail stops exactly at the opening", async () => {
    const lines = Array.from({ length: 5 }, (_, index) => claudeUser(`m${index}`));
    await withFixture(`${lines.join("\n")}\n`, async (path) => {
      const preview = await readSessionPreview({ path, provider: "claude", tailEntries: 5 });
      expect(preview.opening).toBeNull();
      expect(preview.tail).toHaveLength(5);
      expect(preview.gap).toBe(false);
    });
  });

  it("survives a session with nothing renderable in it", async () => {
    await withFixture(`${JSON.stringify({ type: "mode" })}\n`, async (path) => {
      const preview = await readSessionPreview({ path, provider: "claude" });
      expect(preview.opening).toBeNull();
      expect(preview.tail).toEqual([]);
      expect(preview.gap).toBe(false);
    });
  });

  it("previews a Codex rollout whose opening was compacted away", async () => {
    const filler = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: `later ${index}` },
      }),
    );
    const contents = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
      JSON.stringify({
        type: "compacted",
        payload: {
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "the original ask" }],
            },
          ],
        },
      }),
      ...filler,
    ].join("\n");
    await withFixture(`${contents}\n`, async (path) => {
      const preview = await readSessionPreview({ path, provider: "codex", tailEntries: 2 });
      // Without folding the compaction in, this preview would open on
      // "later 0" with nothing to say the session began elsewhere.
      expect(preview.opening?.text).toEqual("the original ask");
      expect(preview.tail.map((entry) => entry.text)).toEqual(["later 10", "later 11"]);
      expect(preview.gap).toBe(true);
    });
  });
});
