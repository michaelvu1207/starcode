// @effect-diagnostics nodeBuiltinImport:off - walks the CLIs' own on-disk session
// stores; the scan is stat-only and deliberately outside Effect's FileSystem service.
/**
 * HistoryIndex - what CLI sessions exist on this machine.
 *
 * In memory, built lazily, never persisted. There is no migration and no
 * table: the CLIs' own jsonl files are the source of truth, and anything we
 * copied into SQLite would be a stale second copy of a 1.2 GB store that the
 * user can delete at will.
 *
 * Three decisions shape everything here.
 *
 * **The index is stat-only.** A build does `readdir` plus `stat` and nothing
 * else — no file is opened. On the local store that is ~4,500 files across two
 * trees, and it is the difference between a cold build measured in
 * milliseconds and one measured in tens of seconds.
 *
 * **Snippets are hydrated per page, not per index.** The listing's snippet and
 * project path come from the front of the file, which for Codex means reading
 * past a ~60-80 KB preamble. Doing that for every rollout at index time would
 * be hundreds of megabytes of I/O to answer a question about forty rows. So
 * the index carries no snippet at all, and the route hydrates only the page it
 * is about to return, cached by (path, mtime, size).
 *
 * **Revalidation is debounced and directory-scoped.** Rescanning compares
 * directory mtimes first and only re-reads directories that changed, which for
 * Codex's date-nested tree means every day but today is skipped outright.
 *
 * @module HistoryIndex
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  HISTORY_SESSIONS_MAX_LIMIT,
  type HistoryProvider,
  type HistorySessionId,
  type HistorySessionSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveSessionTitle, type SessionTitleSource } from "./importFacts.ts";
import {
  CLAUDE_PROJECTS_DIRNAME,
  CODEX_SESSIONS_DIRNAME,
  decodeClaudeProjectDirName,
  historySessionIdForPath,
  isHistorySessionId,
  isSessionFileName,
  projectLabelForPath,
} from "./paths.ts";
import { readSessionHead, readSessionTitleTail } from "./tailReader.ts";

/**
 * Minimum gap between rescans. A sidebar strip that expands, collapses, and
 * expands again should not walk the store three times; anything written in the
 * meantime shows up on the next expand.
 */
export const HISTORY_INDEX_REVALIDATE_DEBOUNCE_MS = 5_000;

/** How many hydrated rows to keep. Comfortably more than a few pages of paging. */
const HYDRATION_CACHE_MAX_ENTRIES = 2_000;

/** One session as the index knows it: everything a `stat` can tell us, and no more. */
export interface HistoryIndexEntry {
  readonly id: HistorySessionId;
  readonly provider: HistoryProvider;
  readonly path: string;
  /** From the path alone. Superseded by the file's own record during hydration. */
  readonly pathDerivedProject: string | null;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

interface HydratedFields {
  readonly projectPath: string | null;
  readonly snippet: string | null;
  readonly title: string | null;
  readonly titleSource: SessionTitleSource | null;
}

export interface HistoryIndexSnapshot {
  /** Newest first, by mtime then id, matching the listing cursor's ordering. */
  readonly entries: ReadonlyArray<HistoryIndexEntry>;
  readonly byId: ReadonlyMap<string, HistoryIndexEntry>;
  readonly indexedAt: number;
}

export interface HistoryIndexShape {
  /**
   * The home directory this index scanned.
   *
   * Exposed because import's ownership check has to resolve a provider
   * instance's configured home against the *same* home the index walked. Two
   * independent calls to `os.homedir()` agree in production and disagree in
   * any test that points the index at a fixture, which is exactly the case
   * that check most needs to be exercised in.
   */
  readonly homeDir: string;
  /** The current index, rebuilt or revalidated if the debounce window has passed. */
  readonly snapshot: () => Effect.Effect<HistoryIndexSnapshot>;
  /**
   * Resolves an opaque id to a file.
   *
   * This is the traversal guard, and it is the only way any route obtains a
   * path. It rejects anything that is not a 32-character hex id before looking
   * at all, then answers strictly from the index's own map — so an id can only
   * name a file the server itself discovered under one of the two known roots.
   */
  readonly resolve: (sessionId: string) => Effect.Effect<HistoryIndexEntry | null>;
  /** Fills in project path and snippet for one page of rows, cached by file identity. */
  readonly hydrate: (
    entries: ReadonlyArray<HistoryIndexEntry>,
  ) => Effect.Effect<ReadonlyArray<HistorySessionSummary>>;
}

export class HistoryIndex extends Context.Service<HistoryIndex, HistoryIndexShape>()(
  "t3/history/HistoryIndex",
) {}

const compareEntries = (left: HistoryIndexEntry, right: HistoryIndexEntry): number => {
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
  // Descending on the id too, so it matches the cursor comparison and a page
  // boundary at a shared mtime neither drops nor repeats a session.
  return right.id.localeCompare(left.id);
};

/** A directory we scanned, and the mtime that lets us skip it next time. */
interface ScannedDirectory {
  readonly mtimeMs: number;
  readonly entries: ReadonlyArray<HistoryIndexEntry>;
}

const statOrNull = async (path: string): Promise<NodeFS.Stats | null> => {
  try {
    return await NodeFSP.stat(path);
  } catch {
    return null;
  }
};

const readdirOrEmpty = async (path: string): Promise<ReadonlyArray<NodeFS.Dirent>> => {
  try {
    return await NodeFSP.readdir(path, { withFileTypes: true });
  } catch {
    // A machine with no Codex installed has no `~/.codex` at all, and a store
    // can be removed mid-scan. Absence is a normal answer, not a failure.
    return [];
  }
};

export const makeHistoryIndex = (options?: {
  readonly homeDir?: string;
  readonly debounceMs?: number;
}): HistoryIndexShape => {
  const homeDir = options?.homeDir ?? NodeOS.homedir();
  const debounceMs = options?.debounceMs ?? HISTORY_INDEX_REVALIDATE_DEBOUNCE_MS;
  const claudeRoot = NodePath.join(homeDir, CLAUDE_PROJECTS_DIRNAME);
  const codexRoot = NodePath.join(homeDir, CODEX_SESSIONS_DIRNAME);

  // Directory mtime cache, so a revalidation re-reads only what changed. For
  // Codex's YYYY/MM/DD tree that is one directory a day.
  const scannedDirectories = new Map<string, ScannedDirectory>();
  const projectPathCache = new Map<string, string>();
  const hydrationCache = new Map<string, HydratedFields>();

  let current: HistoryIndexSnapshot | null = null;
  let lastScanAt = 0;
  let inFlight: Promise<HistoryIndexSnapshot> | null = null;

  // Synchronous by necessity: the decoder walks segment by segment and each
  // step's candidate depends on whether the last one existed. It runs at most
  // once per project directory per process thanks to `projectPathCache`.
  const directoryExists = (candidate: string): boolean => {
    try {
      return NodeFS.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  };

  const decodeProjectDir = (dirName: string): string => {
    const cached = projectPathCache.get(dirName);
    if (cached !== undefined) return cached;
    const decoded = decodeClaudeProjectDirName(dirName, directoryExists);
    projectPathCache.set(dirName, decoded);
    return decoded;
  };

  const scanDirectory = async (
    directory: string,
    provider: HistoryProvider,
    pathDerivedProject: string | null,
  ): Promise<ReadonlyArray<HistoryIndexEntry>> => {
    const stats = await statOrNull(directory);
    if (stats === null || !stats.isDirectory()) {
      scannedDirectories.delete(directory);
      return [];
    }
    const cached = scannedDirectories.get(directory);
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) return cached.entries;

    const dirents = await readdirOrEmpty(directory);
    const entries: HistoryIndexEntry[] = [];
    await Promise.all(
      dirents.map(async (dirent) => {
        if (!dirent.isFile() || !isSessionFileName(dirent.name)) return;
        const path = NodePath.join(directory, dirent.name);
        const fileStats = await statOrNull(path);
        if (fileStats === null) return;
        entries.push({
          id: historySessionIdForPath(path),
          provider,
          path,
          pathDerivedProject,
          mtimeMs: fileStats.mtimeMs,
          sizeBytes: fileStats.size,
        });
      }),
    );
    scannedDirectories.set(directory, { mtimeMs: stats.mtimeMs, entries });
    return entries;
  };

  /** Claude: one directory per project, sessions directly inside it. */
  const scanClaude = async (): Promise<ReadonlyArray<HistoryIndexEntry>> => {
    const dirents = await readdirOrEmpty(claudeRoot);
    const scans = dirents
      .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
      .map((dirent) =>
        scanDirectory(
          NodePath.join(claudeRoot, dirent.name),
          "claude",
          decodeProjectDir(dirent.name),
        ),
      );
    return (await Promise.all(scans)).flat();
  };

  /**
   * Codex: a `YYYY/MM/DD` tree with rollout files at the leaves. Nothing in
   * the path says which project a session belonged to — that only appears in
   * the file's own `session_meta`, so these entries carry no path-derived
   * project and rely entirely on hydration.
   */
  const scanCodex = async (): Promise<ReadonlyArray<HistoryIndexEntry>> => {
    const years = await readdirOrEmpty(codexRoot);
    const dayDirectories: string[] = [];
    await Promise.all(
      years
        .filter((dirent) => dirent.isDirectory() && /^\d{4}$/.test(dirent.name))
        .map(async (year) => {
          const yearPath = NodePath.join(codexRoot, year.name);
          const months = await readdirOrEmpty(yearPath);
          await Promise.all(
            months
              .filter((dirent) => dirent.isDirectory())
              .map(async (month) => {
                const monthPath = NodePath.join(yearPath, month.name);
                for (const day of await readdirOrEmpty(monthPath)) {
                  if (day.isDirectory()) dayDirectories.push(NodePath.join(monthPath, day.name));
                }
              }),
          );
        }),
    );
    const scans = dayDirectories.map((directory) => scanDirectory(directory, "codex", null));
    return (await Promise.all(scans)).flat();
  };

  const build = async (nowMs: number): Promise<HistoryIndexSnapshot> => {
    const [claude, codex] = await Promise.all([scanClaude(), scanCodex()]);
    const entries = [...claude, ...codex].sort(compareEntries);
    const byId = new Map<string, HistoryIndexEntry>();
    for (const entry of entries) byId.set(entry.id, entry);
    return { entries, byId, indexedAt: nowMs };
  };

  const ensureFresh = async (nowMs: number): Promise<HistoryIndexSnapshot> => {
    if (current !== null && nowMs - lastScanAt < debounceMs) return current;
    // A second caller arriving mid-scan joins the scan in flight rather than
    // starting its own: expanding two connection groups at once should walk
    // the store once.
    if (inFlight !== null) return inFlight;
    inFlight = build(nowMs)
      .then((built) => {
        current = built;
        lastScanAt = nowMs;
        return built;
      })
      .finally(() => {
        inFlight = null;
      });
    try {
      return await inFlight;
    } catch {
      // A store that cannot be walked at all yields an empty index rather than
      // a failed request: the sidebar strip should say "no sessions", not
      // raise an error the reader cannot act on.
      return current ?? { entries: [], byId: new Map(), indexedAt: nowMs };
    }
  };

  const snapshot = (): Effect.Effect<HistoryIndexSnapshot> =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) => Effect.promise(() => ensureFresh(nowMs)));

  const hydrationKey = (entry: HistoryIndexEntry): string =>
    `${entry.path}:${entry.mtimeMs}:${entry.sizeBytes}`;

  /**
   * Reads one row's displayable fields.
   *
   * Two reads for Claude, one for Codex. The second is the title scan: Claude
   * rewrites `ai-title` throughout a session so the *last* one is the current
   * title, and the last one is only reachable from the end of the file. Codex
   * writes no titles at all, so it is not asked. Both are bounded, both are
   * cached by file identity, and neither happens until a page is actually
   * being returned — the index itself still opens nothing.
   */
  const hydrateOne = async (entry: HistoryIndexEntry): Promise<HistorySessionSummary> => {
    const key = hydrationKey(entry);
    let fields = hydrationCache.get(key);
    if (fields === undefined) {
      const [head, tailTitle] = await Promise.all([
        readSessionHead({ path: entry.path, provider: entry.provider }).catch(() => ({
          projectPath: null,
          snippet: null,
          aiTitle: null,
        })),
        entry.provider === "claude"
          ? readSessionTitleTail({ path: entry.path }).catch(() => null)
          : Promise.resolve(null),
      ]);
      const projectPath = head.projectPath ?? entry.pathDerivedProject;
      const resolved = resolveSessionTitle({
        aiTitle: tailTitle ?? head.aiTitle,
        firstUserMessage: head.snippet,
        projectLabel: projectLabelForPath(projectPath),
      });
      fields = {
        projectPath: head.projectPath,
        snippet: head.snippet,
        title: resolved.title,
        titleSource: resolved.source,
      };
      if (hydrationCache.size >= HYDRATION_CACHE_MAX_ENTRIES) {
        const oldest = hydrationCache.keys().next();
        if (!oldest.done) hydrationCache.delete(oldest.value);
      }
      hydrationCache.set(key, fields);
    }
    const projectPath = fields.projectPath ?? entry.pathDerivedProject;
    return {
      id: entry.id,
      provider: entry.provider,
      projectPath,
      projectLabel: projectLabelForPath(projectPath),
      snippet: fields.snippet,
      title: fields.title,
      titleSource: fields.titleSource,
      lastActivityAt: DateTime.formatIso(DateTime.makeUnsafe(entry.mtimeMs)),
      sizeBytes: entry.sizeBytes,
    };
  };

  return {
    homeDir,
    snapshot,
    resolve: (sessionId: string) =>
      Effect.gen(function* () {
        // Cheap syntactic rejection first: a path, a traversal sequence, or a
        // URL escape never reaches the map lookup, let alone the filesystem.
        if (!isHistorySessionId(sessionId)) return null;
        const index = yield* snapshot();
        return index.byId.get(sessionId) ?? null;
      }),
    hydrate: (entries: ReadonlyArray<HistoryIndexEntry>) =>
      Effect.promise(() =>
        Promise.all(entries.slice(0, HISTORY_SESSIONS_MAX_LIMIT).map(hydrateOne)),
      ),
  };
};

export const layer: Layer.Layer<HistoryIndex> = Layer.sync(HistoryIndex, () =>
  HistoryIndex.of(makeHistoryIndex()),
);
