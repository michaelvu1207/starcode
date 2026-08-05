// @effect-diagnostics nodeBuiltinImport:off - reads the CLIs' own on-disk session
// stores directly; Effect's FileSystem service has no backwards-read primitive.
/**
 * Terminal history - locating session files and naming them.
 *
 * Everything here is pure apart from an injected `directoryExists` probe, so
 * the awkward part (Claude's lossy directory encoding) can be tested against a
 * temp directory without touching the real home directory.
 *
 * @module HistoryPaths
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { HistoryProvider, HistorySessionId } from "@starcode/contracts";

/** Where each CLI keeps its sessions, relative to the user's home directory. */
export const CLAUDE_PROJECTS_DIRNAME = NodePath.join(".claude", "projects");
export const CODEX_SESSIONS_DIRNAME = NodePath.join(".codex", "sessions");

/**
 * A session's stable, opaque id: the first 128 bits of the SHA-256 of its
 * absolute path.
 *
 * Hashing rather than encoding is deliberate. An encoded path would round-trip
 * — and the moment a client can round-trip an id into a path, the transcript
 * route is a file reader. With a hash the only way back is the server's own
 * index, which only ever contains files it discovered itself.
 */
export const historySessionIdForPath = (absolutePath: string): HistorySessionId =>
  NodeCrypto.createHash("sha256")
    .update(absolutePath)
    .digest("hex")
    .slice(0, 32) as HistorySessionId;

/**
 * True for a string that could be a session id at all.
 *
 * The contract schema already enforces this shape, but the check is repeated
 * at the index boundary because it is the guard, not a formality: a lookup is
 * only ever a `Map.get` on an id that got past here, so no traversal sequence,
 * absolute path, or URL escape ever reaches the filesystem.
 */
export const isHistorySessionId = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);

/**
 * Decodes one of Claude's project directory names back into a working
 * directory.
 *
 * Claude names these by replacing every path separator with `-`, which is
 * lossy: `-Users-me-code-my-app` could be `/Users/me/code/my-app` or
 * `/Users/me/code/my/app`, and there is nothing in the name to say which. So
 * we walk the segments against the real filesystem, committing a separator
 * only where a directory actually exists, and re-joining with `-` otherwise.
 *
 * When the reconstruction does not exist — the project was moved or deleted —
 * we fall back to the naive all-separators reading. That is a display string
 * either way; the authoritative working directory comes from the session's own
 * records during hydration, and this only has to be good enough to group and
 * label rows before that happens.
 */
export const decodeClaudeProjectDirName = (
  dirName: string,
  directoryExists: (candidate: string) => boolean,
): string => {
  const naive = dirName.replace(/-/g, NodePath.sep);
  const segments = dirName.split("-");
  // A leading separator produces an empty first segment. Without one the name
  // is not a path we recognise, so take the naive reading and move on.
  if (segments.length < 2 || segments[0] !== "") return naive;

  let resolved = "";
  let pending = segments[1] ?? "";
  for (const segment of segments.slice(2)) {
    if (pending.length > 0 && directoryExists(`${resolved}${NodePath.sep}${pending}`)) {
      resolved = `${resolved}${NodePath.sep}${pending}`;
      pending = segment;
      continue;
    }
    pending = pending.length > 0 ? `${pending}-${segment}` : segment;
  }
  const candidate = `${resolved}${NodePath.sep}${pending}`;
  return directoryExists(candidate) ? candidate : naive;
};

/** Last path segment, for a sidebar row with no room for the rest. */
export const projectLabelForPath = (projectPath: string | null): string | null => {
  if (projectPath === null) return null;
  const base = NodePath.basename(projectPath);
  return base.length > 0 ? base : projectPath;
};

/**
 * True for a file the index should consider.
 *
 * Both stores hold more than sessions. Claude's project directories contain a
 * `memory/` subdirectory and, under a session's own name, a `subagents/`
 * directory whose transcripts are fragments of their parent — listing those as
 * peers of real sessions would be wrong, and some of them are tens of
 * megabytes. Codex's tree collects `.DS_Store`. Restricting to `.jsonl` files
 * at the expected depth excludes all of it without an exclusion list to
 * maintain.
 */
export const isSessionFileName = (fileName: string): boolean =>
  fileName.endsWith(".jsonl") && !fileName.startsWith(".");

/** Provider a discovered file belongs to, by which root it was found under. */
export interface DiscoveredSessionFile {
  readonly path: string;
  readonly provider: HistoryProvider;
  /**
   * Best-effort working directory from the *path alone*, before any file is
   * read. Claude encodes it in the directory name; Codex's tree is dated, not
   * project-scoped, so it has none until the file is hydrated.
   */
  readonly pathDerivedProject: string | null;
}
