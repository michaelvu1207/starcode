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
 * **The session index is stat-only.** A build does `readdir` plus `stat` and
 * nothing else for ordinary sessions. Claude subagent metadata is the one
 * deliberately small exception: an adjacent `.meta.json` is read when its
 * `subagents/` directory changes because its `toolUseId` is the ownership
 * proof. Those hidden entries never join the ordinary session listing.
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
} from "@starcode/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveSessionTitle, type SessionTitleSource } from "./importFacts.ts";
import {
  CLAUDE_PROJECTS_DIRNAME,
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

/** Claude's adjacent agent metadata is tiny. Refuse an unexpectedly large file. */
const CLAUDE_SUBAGENT_META_MAX_BYTES = 64 * 1024;

const CLAUDE_SUBAGENT_FILE_PATTERN = /^agent-(.+)\.jsonl$/;

export interface ClaudeSubagentHistoryMetadata {
  readonly toolUseId: string;
  readonly agentType: string | null;
  readonly description: string | null;
  readonly model: string | null;
  readonly spawnDepth: number | null;
}

/** One session as the index knows it: everything a `stat` can tell us, and no more. */
export interface HistoryIndexEntry {
  /**
   * Subagent entries are resolvable transcripts but never members of
   * `HistoryIndexSnapshot.entries`, which is the top-level session listing.
   */
  readonly kind: "session" | "subagent";
  readonly id: HistorySessionId;
  readonly provider: HistoryProvider;
  readonly path: string;
  /** From the path alone. Superseded by the file's own record during hydration. */
  readonly pathDerivedProject: string | null;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  /** Claude only, present exactly for `kind=subagent`. */
  readonly parentNativeSessionId?: string;
  /** Claude's provider task id, read from `agent-<taskId>.jsonl`. */
  readonly agentRunId?: string;
  /** Parsed adjacent metadata. Null means absent, malformed, or oversized. */
  readonly claudeSubagentMetadata?: ClaudeSubagentHistoryMetadata | null;
}

interface HydratedFields {
  readonly projectPath: string | null;
  readonly snippet: string | null;
  readonly title: string | null;
  readonly titleSource: SessionTitleSource | null;
}

export interface HistoryIndexSnapshot {
  /**
   * Top-level sessions only, newest first by mtime then id.
   *
   * Hidden Claude subagent transcripts deliberately live only in `byId`.
   */
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
  /**
   * Resolves one Claude agent transcript only when all native ownership
   * evidence agrees. Missing metadata and duplicate matches both return null;
   * neither is safe to guess through.
   */
  readonly findClaudeSubagent: (input: {
    readonly parentNativeSessionId: string;
    readonly agentRunId: string;
    readonly launchToolUseId: string;
  }) => Effect.Effect<HistoryIndexEntry | null>;
  /** Fills in project path and snippet for one page of rows, cached by file identity. */
  readonly hydrate: (
    entries: ReadonlyArray<HistoryIndexEntry>,
  ) => Effect.Effect<ReadonlyArray<HistorySessionSummary>>;
}

export class HistoryIndex extends Context.Service<HistoryIndex, HistoryIndexShape>()(
  "starcode/history/HistoryIndex",
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

interface ClaudeProjectChildren {
  readonly mtimeMs: number;
  readonly subagentDirectories: ReadonlyArray<{
    readonly parentNativeSessionId: string;
    readonly path: string;
  }>;
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

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isNotNull = <A>(value: A | null): value is A => value !== null;

const readClaudeSubagentMetadata = async (
  path: string,
): Promise<ClaudeSubagentHistoryMetadata | null> => {
  const stats = await statOrNull(path);
  if (
    stats === null ||
    !stats.isFile() ||
    stats.size <= 0 ||
    stats.size > CLAUDE_SUBAGENT_META_MAX_BYTES
  ) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const record = decoded as Record<string, unknown>;
    const toolUseId = nonEmptyString(record["toolUseId"]);
    if (toolUseId === null) return null;
    return {
      toolUseId,
      agentType: nonEmptyString(record["agentType"]),
      description: nonEmptyString(record["description"]),
      model: nonEmptyString(record["model"]),
      spawnDepth:
        typeof record["spawnDepth"] === "number" &&
        Number.isInteger(record["spawnDepth"]) &&
        record["spawnDepth"] >= 0
          ? record["spawnDepth"]
          : null,
    };
  } catch {
    return null;
  }
};

export const makeHistoryIndex = (options?: {
  readonly homeDir?: string;
  /** Codex config root (`CODEX_HOME`), whose session store is `sessions/`. */
  readonly codexHome?: string;
  readonly debounceMs?: number;
}): HistoryIndexShape => {
  const homeDir = options?.homeDir ?? NodeOS.homedir();
  const debounceMs = options?.debounceMs ?? HISTORY_INDEX_REVALIDATE_DEBOUNCE_MS;
  const claudeRoot = NodePath.join(homeDir, CLAUDE_PROJECTS_DIRNAME);
  // Explicit test homes stay self-contained. Production, where no home is
  // injected, follows the same CODEX_HOME override that launches and rollout
  // correlation use; otherwise a worker can be linked successfully while its
  // transcript remains invisible to the history endpoint.
  const codexHome =
    options?.codexHome ??
    (options?.homeDir === undefined ? process.env.CODEX_HOME : undefined) ??
    NodePath.join(homeDir, ".codex");
  const codexRoot = NodePath.join(codexHome, "sessions");

  // Directory mtime cache, so a revalidation re-reads only what changed. For
  // Codex's YYYY/MM/DD tree that is one directory a day.
  const scannedDirectories = new Map<string, ScannedDirectory>();
  const scannedClaudeSubagentDirectories = new Map<string, ScannedDirectory>();
  const claudeProjectChildren = new Map<string, ClaudeProjectChildren>();
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
          kind: "session",
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

  const scanClaudeSubagentDirectory = async (input: {
    readonly directory: string;
    readonly parentNativeSessionId: string;
    readonly pathDerivedProject: string;
  }): Promise<ReadonlyArray<HistoryIndexEntry>> => {
    const stats = await statOrNull(input.directory);
    if (stats === null || !stats.isDirectory()) {
      scannedClaudeSubagentDirectories.delete(input.directory);
      return [];
    }
    const cached = scannedClaudeSubagentDirectories.get(input.directory);
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) return cached.entries;

    const entries = (
      await Promise.all(
        (
          await readdirOrEmpty(input.directory)
        ).map(async (dirent) => {
          if (!dirent.isFile()) return null;
          const match = CLAUDE_SUBAGENT_FILE_PATTERN.exec(dirent.name);
          const agentRunId = nonEmptyString(match?.[1]);
          if (agentRunId === null) return null;

          const path = NodePath.join(input.directory, dirent.name);
          const fileStats = await statOrNull(path);
          if (fileStats === null || !fileStats.isFile()) return null;
          const metaPath = NodePath.join(input.directory, `agent-${agentRunId}.meta.json`);
          const metadata = await readClaudeSubagentMetadata(metaPath);
          return {
            kind: "subagent",
            id: historySessionIdForPath(path),
            provider: "claude",
            path,
            pathDerivedProject: input.pathDerivedProject,
            mtimeMs: fileStats.mtimeMs,
            sizeBytes: fileStats.size,
            parentNativeSessionId: input.parentNativeSessionId,
            agentRunId,
            claudeSubagentMetadata: metadata,
          } satisfies HistoryIndexEntry;
        }),
      )
    ).filter(isNotNull);

    scannedClaudeSubagentDirectories.set(input.directory, {
      mtimeMs: stats.mtimeMs,
      entries,
    });
    return entries;
  };

  const claudeSubagentDirectories = async (
    projectDirectory: string,
  ): Promise<ClaudeProjectChildren["subagentDirectories"]> => {
    const stats = await statOrNull(projectDirectory);
    if (stats === null || !stats.isDirectory()) {
      claudeProjectChildren.delete(projectDirectory);
      return [];
    }
    const cached = claudeProjectChildren.get(projectDirectory);
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) {
      return cached.subagentDirectories;
    }
    const subagentDirectories = (await readdirOrEmpty(projectDirectory))
      .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
      .map((dirent) => ({
        parentNativeSessionId: dirent.name,
        path: NodePath.join(projectDirectory, dirent.name, "subagents"),
      }));
    claudeProjectChildren.set(projectDirectory, { mtimeMs: stats.mtimeMs, subagentDirectories });
    return subagentDirectories;
  };

  /**
   * Claude: top-level sessions are direct project children. Agent transcripts
   * are hidden one level below a parent session and are returned separately so
   * no listing caller can accidentally include them.
   */
  const scanClaude = async (): Promise<{
    readonly sessions: ReadonlyArray<HistoryIndexEntry>;
    readonly subagents: ReadonlyArray<HistoryIndexEntry>;
  }> => {
    const projects = (await readdirOrEmpty(claudeRoot))
      .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
      .map((dirent) => ({
        directory: NodePath.join(claudeRoot, dirent.name),
        pathDerivedProject: decodeProjectDir(dirent.name),
      }));
    const sessions = (
      await Promise.all(
        projects.map((project) =>
          scanDirectory(project.directory, "claude", project.pathDerivedProject),
        ),
      )
    ).flat();
    const childDirectories = (
      await Promise.all(
        projects.map(async (project) =>
          (await claudeSubagentDirectories(project.directory)).map((child) => ({
            ...child,
            pathDerivedProject: project.pathDerivedProject,
          })),
        ),
      )
    ).flat();
    const subagents = (
      await Promise.all(
        childDirectories.map((child) =>
          scanClaudeSubagentDirectory({
            directory: child.path,
            parentNativeSessionId: child.parentNativeSessionId,
            pathDerivedProject: child.pathDerivedProject,
          }),
        ),
      )
    ).flat();
    return { sessions, subagents };
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
    const entries = [...claude.sessions, ...codex].sort(compareEntries);
    const byId = new Map<string, HistoryIndexEntry>();
    for (const entry of entries) byId.set(entry.id, entry);
    for (const entry of claude.subagents) byId.set(entry.id, entry);
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
    findClaudeSubagent: (input) =>
      Effect.gen(function* () {
        const parentNativeSessionId = nonEmptyString(input.parentNativeSessionId);
        const agentRunId = nonEmptyString(input.agentRunId);
        const launchToolUseId = nonEmptyString(input.launchToolUseId);
        if (parentNativeSessionId === null || agentRunId === null || launchToolUseId === null) {
          return null;
        }
        const index = yield* snapshot();
        const matches = Array.from(index.byId.values()).filter(
          (entry) =>
            entry.kind === "subagent" &&
            entry.provider === "claude" &&
            entry.parentNativeSessionId === parentNativeSessionId &&
            entry.agentRunId === agentRunId &&
            entry.claudeSubagentMetadata?.toolUseId === launchToolUseId,
        );
        return matches.length === 1 ? (matches[0] ?? null) : null;
      }),
    hydrate: (entries: ReadonlyArray<HistoryIndexEntry>) =>
      Effect.promise(() =>
        Promise.all(entries.slice(0, HISTORY_SESSIONS_MAX_LIMIT).map(hydrateOne)),
      ),
  };
};

/**
 * Shared fail-closed index for agent transcript ownership reconciliation.
 *
 * Agent files are short-lived around launch/completion boundaries, so this
 * instance disables the public listing debounce while retaining the same
 * directory-mtime caches and in-flight scan coalescing.
 */
export const agentTranscriptHistoryIndex = makeHistoryIndex({ debounceMs: 0 });

export const layer: Layer.Layer<HistoryIndex> = Layer.sync(HistoryIndex, () =>
  HistoryIndex.of(makeHistoryIndex()),
);
