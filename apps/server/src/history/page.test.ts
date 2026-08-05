// @effect-diagnostics nodeBuiltinImport:off - writes real fixture files, because
// every property under test is a byte offset into one.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { clampPageEntries, parsePageCursor, readSessionPage } from "./page.ts";

const withFixture = async (
  contents: string,
  use: (path: string) => Promise<void>,
): Promise<void> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-history-page-"));
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

const session = (count: number): string =>
  `${Array.from({ length: count }, (_unused, index) => claudeUser(`m${index}`)).join("\n")}\n`;

/**
 * Walks a session to the top the way the client does, and returns every entry
 * it saw in reading order.
 *
 * The loop is the point. Paging is only correct if repeatedly feeding
 * `nextBefore` back terminates, never repeats an entry, and never skips one —
 * three properties no single-page assertion can establish.
 */
const readEverything = async (input: {
  readonly path: string;
  readonly limit: number;
  readonly before?: number;
}): Promise<{ texts: ReadonlyArray<string>; requests: number }> => {
  const texts: string[] = [];
  let before = input.before;
  let requests = 0;
  while (requests < 100) {
    const page = await readSessionPage({
      path: input.path,
      provider: "claude",
      before,
      limit: input.limit,
    });
    requests += 1;
    texts.unshift(...page.entries.map((entry) => entry.text));
    if (page.nextBefore === null) break;
    before = page.nextBefore;
  }
  return { texts, requests };
};

describe("readSessionPage", () => {
  it("serves the newest entries first", async () => {
    await withFixture(session(40), async (path) => {
      const page = await readSessionPage({ path, provider: "claude", limit: 3 });

      // Oldest first within the page, newest page first overall: the order a
      // thread is read in, opened at the end.
      expect(page.entries.map((entry) => entry.text)).toEqual(["m37", "m38", "m39"]);
      expect(page.nextBefore).not.toBeNull();
    });
  });

  it("walks a session to the top without repeating or skipping an entry", async () => {
    await withFixture(session(40), async (path) => {
      const walked = await readEverything({ path, limit: 7 });

      expect(walked.texts).toEqual(Array.from({ length: 40 }, (_unused, index) => `m${index}`));
      // 40 entries at 7 a page is 6 pages; the sixth reaches offset 0 and ends
      // the walk rather than returning a seventh cursor pointing at nothing.
      expect(walked.requests).toBe(6);
    });
  });

  it("ends the walk rather than looping when the file is exhausted", async () => {
    await withFixture(session(3), async (path) => {
      const page = await readSessionPage({ path, provider: "claude", limit: 30 });

      expect(page.entries).toHaveLength(3);
      // The whole session fit, so there is nothing earlier and "show earlier"
      // must not offer itself.
      expect(page.nextBefore).toBeNull();
    });
  });

  it("stops at the boundary a thread inherited, not at the end of the file", async () => {
    const inherited = session(10);
    // What the imported thread itself went on to append to the CLI's own file.
    const contents = `${inherited}${session(4).replace(/m(\d)/g, "live$1")}`;
    await withFixture(contents, async (path) => {
      const walked = await readEverything({
        path,
        limit: 30,
        before: Buffer.byteLength(inherited, "utf8"),
      });

      // Without the boundary these four would appear in the history section as
      // well as in the live timeline — every message shown twice.
      expect(walked.texts).toEqual(Array.from({ length: 10 }, (_unused, index) => `m${index}`));
      expect(walked.texts.some((text) => text.startsWith("live"))).toBe(false);
    });
  });

  it("treats a boundary of zero as a session with nothing behind it", async () => {
    await withFixture(session(10), async (path) => {
      const page = await readSessionPage({ path, provider: "claude", before: 0, limit: 30 });

      expect(page.entries).toEqual([]);
      expect(page.nextBefore).toBeNull();
    });
  });

  it("walks past records that render to nothing instead of re-reading them", async () => {
    // A realistic shape: a burst of records the renderer discards sitting
    // between two messages. The cursor has to step past the whole burst, or
    // every later page pays to skip it again.
    const unrenderable = Array.from({ length: 30 }, () => JSON.stringify({ type: "mode" }));
    const contents = `${[claudeUser("first"), ...unrenderable, claudeUser("last")].join("\n")}\n`;
    await withFixture(contents, async (path) => {
      const page = await readSessionPage({ path, provider: "claude", limit: 1 });

      expect(page.entries.map((entry) => entry.text)).toEqual(["last"]);
      const walked = await readEverything({ path, limit: 1 });
      expect(walked.texts).toEqual(["first", "last"]);
      // Two messages, two pages, and the third request only to learn the file
      // is exhausted — the burst is not re-scanned per page.
      expect(walked.requests).toBeLessThanOrEqual(3);
    });
  });

  it("keeps paging correct when records straddle a chunk boundary", async () => {
    await withFixture(session(24), async (path) => {
      // A chunk far smaller than a record forces the reader's carry path,
      // which is where an off-by-one in the offsets would surface.
      const first = await readSessionPage({
        path,
        provider: "claude",
        limit: 5,
        chunkBytes: 48,
      });
      expect(first.entries.map((entry) => entry.text)).toEqual(["m19", "m20", "m21", "m22", "m23"]);
      expect(first.nextBefore).not.toBeNull();

      const second = await readSessionPage({
        path,
        provider: "claude",
        limit: 5,
        before: first.nextBefore ?? undefined,
        chunkBytes: 48,
      });
      expect(second.entries.map((entry) => entry.text)).toEqual([
        "m14",
        "m15",
        "m16",
        "m17",
        "m18",
      ]);
    });
  });

  it("returns a short page rather than a slow one when the byte budget runs out", async () => {
    const fat = claudeUser("x".repeat(200_000));
    const contents = `${[claudeUser("old"), fat, fat, claudeUser("new")].join("\n")}\n`;
    await withFixture(contents, async (path) => {
      const page = await readSessionPage({
        path,
        provider: "claude",
        limit: 30,
        maxPageBytes: 64 * 1024,
      });

      // Short, but honest: the cursor says there is more, so the reader offers
      // to load earlier instead of implying the session starts here.
      expect(page.entries.length).toBeLessThan(4);
      expect(page.nextBefore).not.toBeNull();
    });
  });
});

describe("clampPageEntries", () => {
  it("defaults rather than failing on a garbled limit", () => {
    // Arriving as a query string means anything can arrive. A thread opening
    // its history should not 400 because a value was mistyped.
    expect(clampPageEntries(undefined)).toBe(30);
    expect(clampPageEntries("not-a-number")).toBe(30);
    expect(clampPageEntries("0")).toBe(30);
    expect(clampPageEntries("-5")).toBe(30);
  });

  it("caps a limit at the ceiling and honours one below it", () => {
    expect(clampPageEntries("10")).toBe(10);
    expect(clampPageEntries("100000")).toBe(100);
  });
});

describe("parsePageCursor", () => {
  it("reads a byte cursor and rejects anything else", () => {
    expect(parsePageCursor("1024")).toBe(1024);
    expect(parsePageCursor("0")).toBe(0);
    expect(parsePageCursor(undefined)).toBeNull();
    expect(parsePageCursor("-1")).toBeNull();
    expect(parsePageCursor("../etc/passwd")).toBeNull();
  });
});
