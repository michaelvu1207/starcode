// @effect-diagnostics nodeBuiltinImport:off - exercises real directories so the
// lossy project-name decoder is tested against a filesystem, not a stub.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  decodeClaudeProjectDirName,
  historySessionIdForPath,
  isHistorySessionId,
  isSessionFileName,
  projectLabelForPath,
} from "./paths.ts";

const withTempTree = async (
  directories: ReadonlyArray<string>,
  use: (root: string) => void | Promise<void>,
): Promise<void> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-history-paths-"));
  try {
    for (const directory of directories) {
      await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true });
    }
    await use(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const exists = (candidate: string): boolean => {
  try {
    return NodeFS.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

describe("historySessionIdForPath", () => {
  it("is stable, hex, and does not reveal the path", () => {
    const id = historySessionIdForPath("/Users/me/.claude/projects/-Users-me-app/abc.jsonl");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toEqual(
      historySessionIdForPath("/Users/me/.claude/projects/-Users-me-app/abc.jsonl"),
    );
    // The whole point of hashing: nothing in the id can be read back as a path.
    expect(id).not.toContain("Users");
  });

  it("separates files that differ only in directory", () => {
    expect(historySessionIdForPath("/a/session.jsonl")).not.toEqual(
      historySessionIdForPath("/b/session.jsonl"),
    );
  });
});

describe("isHistorySessionId", () => {
  it("accepts a minted id", () => {
    expect(isHistorySessionId(historySessionIdForPath("/a/b.jsonl"))).toBe(true);
  });

  it("rejects everything path-shaped", () => {
    // These are the shapes an attacker would reach for. None of them may reach
    // the index lookup, let alone the filesystem.
    for (const forged of [
      "../../../etc/passwd",
      "/etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "0123456789abcdef0123456789abcde/", // right length, wrong alphabet
      "0123456789ABCDEF0123456789ABCDEF", // uppercase hex
      "0123456789abcdef0123456789abcde", // 31 chars
      "0123456789abcdef0123456789abcdef0", // 33 chars
      "",
    ]) {
      expect(isHistorySessionId(forged)).toBe(false);
    }
  });
});

describe("decodeClaudeProjectDirName", () => {
  it("keeps dashes that belong to a directory name", async () => {
    await withTempTree(["Users/me/code/carla-scenario-editor"], (root) => {
      const encoded = `${root}/Users/me/code/carla-scenario-editor`.replace(/\//g, "-");
      // The naive reading would produce .../carla/scenario/editor. Probing the
      // filesystem is the only way to tell the two apart.
      expect(decodeClaudeProjectDirName(encoded, exists)).toEqual(
        NodePath.join(root, "Users/me/code/carla-scenario-editor"),
      );
    });
  });

  it("splits on dashes that are separators", async () => {
    await withTempTree(["Users/me/code/app"], (root) => {
      const encoded = `${root}/Users/me/code/app`.replace(/\//g, "-");
      expect(decodeClaudeProjectDirName(encoded, exists)).toEqual(
        NodePath.join(root, "Users/me/code/app"),
      );
    });
  });

  it("falls back to the naive reading for a project that no longer exists", () => {
    expect(decodeClaudeProjectDirName("-gone-forever-project", () => false)).toEqual(
      "/gone/forever/project",
    );
  });

  it("leaves a name that is not path-shaped alone", () => {
    expect(decodeClaudeProjectDirName("relative", () => false)).toEqual("relative");
  });
});

describe("projectLabelForPath", () => {
  it("takes the last segment", () => {
    expect(projectLabelForPath("/Users/me/code/app")).toEqual("app");
    expect(projectLabelForPath(null)).toBeNull();
  });
});

describe("isSessionFileName", () => {
  it("accepts session logs and rejects everything else in the store", () => {
    expect(isSessionFileName("abc.jsonl")).toBe(true);
    expect(isSessionFileName(".DS_Store")).toBe(false);
    expect(isSessionFileName("notes.md")).toBe(false);
    expect(isSessionFileName(".hidden.jsonl")).toBe(false);
  });
});
