// @effect-diagnostics nodeBuiltinImport:off - walks the CLIs' own on-disk session
// stores, like `history/HistoryIndex.ts`; the scan is stat-only.
/**
 * Finding every session file that could carry spend.
 *
 * This deliberately does **not** reuse `HistoryIndex`'s scan, even though both
 * walk the same two roots, because they need different files. The history
 * listing wants conversations a human might reopen, so it stops at the top
 * level of each Claude project directory and skips the `subagents/` trees
 * beneath. Spend does not work that way: on this machine 1,016 of 1,123 Claude
 * session files are subagent transcripts, and every one of them is a real API
 * call on a real bill. Costing only the 107 top-level files would report a
 * small fraction of what was actually spent.
 *
 * So this walks both stores to full depth and lets the parsers decide what
 * counts. Files that carry no usage records — Claude's `memory/` notes,
 * `tool-results/` payloads — cost one scan of their lines and contribute
 * nothing, which is cheaper than maintaining an exclusion list that upstream
 * can invalidate.
 *
 * @module CliUsageScan
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { CliUsageProvider } from "@t3tools/contracts";

import { CLAUDE_PROJECTS_DIRNAME, isSessionFileName } from "../../history/paths.ts";

/**
 * Codex's stores, relative to the home directory.
 *
 * `archived_sessions` is included and `ccusage` does not include it. That is a
 * deliberate divergence, not an oversight: on this machine the two trees are
 * near-disjoint (59 of 4,044 session ids appear in both), archived holds ~900
 * sessions that exist nowhere else, and it accounts for over half the recorded
 * Codex tokens. Omitting it would report roughly half of what was spent.
 */
export const CODEX_SESSION_DIRNAMES = [
  NodePath.join(".codex", "sessions"),
  NodePath.join(".codex", "archived_sessions"),
] as const;

export const CODEX_CONFIG_RELATIVE_PATH = NodePath.join(".codex", "config.toml");

/** One session file, identified well enough to cache a parse of it. */
export interface ScannedSessionFile {
  readonly path: string;
  readonly provider: CliUsageProvider;
  /** Cache identity: a file whose size and mtime are unchanged is unchanged. */
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

const readdirOrEmpty = async (directory: string): Promise<ReadonlyArray<NodeFS.Dirent>> => {
  try {
    return await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch {
    // A machine with no Codex installed has no `~/.codex`, and a store can be
    // removed mid-walk. Absence is a normal answer here, not a failure.
    return [];
  }
};

const walk = async (
  directory: string,
  provider: CliUsageProvider,
  into: Array<ScannedSessionFile>,
): Promise<void> => {
  const dirents = await readdirOrEmpty(directory);
  const descend: Array<Promise<void>> = [];
  const stats: Array<Promise<void>> = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const full = NodePath.join(directory, dirent.name);
    if (dirent.isDirectory()) {
      descend.push(walk(full, provider, into));
      continue;
    }
    if (!dirent.isFile() || !isSessionFileName(dirent.name)) continue;
    stats.push(
      NodeFSP.stat(full)
        .then((stat) => {
          into.push({
            path: full,
            provider,
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
          });
        })
        // A file deleted between readdir and stat simply is not there.
        .catch(() => undefined),
    );
  }
  await Promise.all([...descend, ...stats]);
};

/**
 * Every session file under a home directory, both CLIs, newest first.
 *
 * Newest-first matters for the incremental pass: when a scan is interrupted the
 * work that landed is the work that mattered most.
 */
export const scanSessionFiles = async (
  homeDir: string,
): Promise<ReadonlyArray<ScannedSessionFile>> => {
  const found: Array<ScannedSessionFile> = [];
  await Promise.all([
    walk(NodePath.join(homeDir, CLAUDE_PROJECTS_DIRNAME), "claude", found),
    ...CODEX_SESSION_DIRNAMES.map((dirname) =>
      walk(NodePath.join(homeDir, dirname), "codex", found),
    ),
  ]);
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs);
};

/**
 * True when the machine's Codex is configured for a priority service tier.
 *
 * Parsed with a regex rather than a TOML library: this is one scalar in a file
 * the fork does not otherwise read, and a dependency for it would be the larger
 * change. A file we cannot read means standard tier, which under-reports rather
 * than inflates.
 */
export const readCodexPriorityTier = async (homeDir: string): Promise<boolean> => {
  try {
    const contents = await NodeFSP.readFile(
      NodePath.join(homeDir, CODEX_CONFIG_RELATIVE_PATH),
      "utf8",
    );
    return /^\s*service_tier\s*=\s*["'](priority|fast)["']/m.test(contents);
  } catch {
    return false;
  }
};
