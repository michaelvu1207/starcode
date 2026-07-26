// @effect-diagnostics nodeBuiltinImport:off - owns a cache file next to the CLI
// stores it mirrors; the scan and parse below are outside Effect's FileSystem service.
/**
 * CliUsageStore - what the machine's CLIs spent, before and outside this fork.
 *
 * The accounts panel used to read zero because the only thing feeding it was
 * the fork's own turn ingestion, and a machine that has run its agents through
 * `claude` and `codex` in a terminal for a year has none of that. This service
 * is the other half: it reads the CLIs' own session stores and prices them.
 *
 * Three constraints shape the design.
 *
 * **It must never block the snapshot endpoint.** A cold pass over both stores is
 * ~9 GB of I/O and takes tens of seconds. So reads answer from the last
 * completed aggregate — possibly `scanning` with nothing in it — and a refresh
 * runs in the background. The endpoint is never the thing that waits.
 *
 * **It must be incremental.** Session files are append-only and immutable once
 * their day passes, so a file whose size and mtime are unchanged is re-used
 * from the cache and never re-read. A warm refresh touches only what changed,
 * which after the first pass is a handful of files.
 *
 * **It must not need a migration.** The cache is a JSON file under the state
 * dir alongside `history-imports.json` and `peers.json`, per the fork's
 * convention of not spending migration risk on derived data. It is a cache in
 * the strict sense: deleting it costs one slow refresh and nothing else, so any
 * version mismatch or parse failure discards it rather than trying to repair it.
 *
 * @module CliUsageStore
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import type { CliHistoricalUsage, CliUsageProvider } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import {
  aggregateCliUsage,
  EMPTY_MODEL_ALIASES,
  type ModelAliasMap,
  type ProviderFileUsage,
} from "./aggregate.ts";
import {
  CliUsageModelAliasRegistry,
  toModelAliasMap,
} from "./modelAliasRegistry.ts";
import {
  type DayBucketer,
  EMPTY_PARSED_FILE_USAGE,
  type KeyedMessage,
  makeDayBucketer,
  type ParsedFileUsage,
  parseSessionFile,
  type UsageBucket,
} from "./parse.ts";
import { readCodexPriorityTier, scanSessionFiles } from "./scan.ts";

/**
 * How long a completed aggregate is served before a refresh is triggered.
 *
 * Generous on purpose. Historical spend is, by definition, mostly history: the
 * only thing a faster refresh would catch is the current session's own turns,
 * which the fork's live ingestion already reports alongside it.
 */
export const CLI_USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Files read concurrently. Enough to keep the disk busy, few enough to stay polite. */
const PARSE_CONCURRENCY = 8;

/** Bumped whenever the cached shape or the pricing table changes meaning. */
const CACHE_VERSION = 1;

interface CachedFile {
  readonly provider: CliUsageProvider;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly parsed: ParsedFileUsage;
}

/**
 * Cache rows are tuples, not objects.
 *
 * There are ~68,000 of them on this machine and the field names would be four
 * fifths of the file. Tuples keep it around 6 MB and its parse under a fifth of
 * a second, which is the difference between a cache that pays for itself on
 * startup and one that does not.
 */
type KeyedTuple = readonly [
  dedupKey: string,
  day: string,
  model: string,
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
];
type BucketTuple = readonly [
  day: string,
  model: string,
  messages: number,
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
];
interface CacheFileEntry {
  readonly p: CliUsageProvider;
  readonly m: number;
  readonly s: number;
  readonly k: ReadonlyArray<KeyedTuple>;
  readonly b: ReadonlyArray<BucketTuple>;
}
interface CacheFile {
  readonly version: number;
  readonly files: Readonly<Record<string, CacheFileEntry>>;
}

const encodeEntry = (path: string, cached: CachedFile): [string, CacheFileEntry] => [
  path,
  {
    p: cached.provider,
    m: cached.mtimeMs,
    s: cached.sizeBytes,
    k: cached.parsed.keyed.map(
      (message) =>
        [
          message.dedupKey,
          message.day,
          message.model,
          message.inputTokens,
          message.outputTokens,
          message.cacheWrite5mTokens,
          message.cacheWrite1hTokens,
          message.cacheReadTokens,
        ] as const,
    ),
    b: cached.parsed.buckets.map(
      (bucket) =>
        [
          bucket.day,
          bucket.model,
          bucket.messages,
          bucket.inputTokens,
          bucket.outputTokens,
          bucket.cacheWrite5mTokens,
          bucket.cacheWrite1hTokens,
          bucket.cacheReadTokens,
        ] as const,
    ),
  },
];

const decodeEntry = (entry: unknown): CachedFile | null => {
  if (typeof entry !== "object" || entry === null) return null;
  const candidate = entry as Partial<CacheFileEntry>;
  if (candidate.p !== "claude" && candidate.p !== "codex") return null;
  if (typeof candidate.m !== "number" || typeof candidate.s !== "number") return null;
  if (!Array.isArray(candidate.k) || !Array.isArray(candidate.b)) return null;

  const keyed: Array<KeyedMessage> = [];
  for (const row of candidate.k) {
    if (!Array.isArray(row) || row.length < 8) return null;
    keyed.push({
      dedupKey: String(row[0]),
      day: String(row[1]),
      model: String(row[2]),
      inputTokens: Number(row[3]),
      outputTokens: Number(row[4]),
      cacheWrite5mTokens: Number(row[5]),
      cacheWrite1hTokens: Number(row[6]),
      cacheReadTokens: Number(row[7]),
    });
  }
  const buckets: Array<UsageBucket> = [];
  for (const row of candidate.b) {
    if (!Array.isArray(row) || row.length < 8) return null;
    buckets.push({
      day: String(row[0]),
      model: String(row[1]),
      messages: Number(row[2]),
      inputTokens: Number(row[3]),
      outputTokens: Number(row[4]),
      cacheWrite5mTokens: Number(row[5]),
      cacheWrite1hTokens: Number(row[6]),
      cacheReadTokens: Number(row[7]),
    });
  }
  return {
    provider: candidate.p,
    mtimeMs: candidate.m,
    sizeBytes: candidate.s,
    parsed: { keyed, buckets },
  };
};

const MILLIS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for the day `daysBefore` days before `nowMs`, in the report zone. */
const dayOffsetFrom = (nowMs: number, daysBefore: number, toDay: DayBucketer): string =>
  toDay.fromMillis(nowMs - daysBefore * MILLIS_PER_DAY);

export interface CliUsageStoreShape {
  /**
   * The last completed aggregate. Answers immediately, always: before the first
   * pass finishes this is a `scanning` placeholder, never a wait.
   */
  readonly current: Effect.Effect<CliHistoricalUsage>;
  /** Starts a refresh unless one is running or the aggregate is still fresh. */
  readonly refresh: Effect.Effect<void>;
  /**
   * Re-prices the last completed pass against the current alias registry,
   * without touching the disk.
   *
   * This is the whole reason the cache stores tokens rather than dollars: a
   * user who assigns `gpt-5.6-sol` a price waits for arithmetic over what is
   * already in memory, not for a second walk over nine gigabytes. Falls back
   * to a normal refresh when no pass has completed, because there is then
   * nothing in memory to re-price.
   */
  readonly reprice: Effect.Effect<void>;
}

export class CliUsageStore extends Context.Service<CliUsageStore, CliUsageStoreShape>()(
  "t3/usage/cli/CliUsageStore",
) {}

export interface MakeCliUsageStoreOptions {
  readonly cachePath: string;
  readonly homeDir?: string;
  readonly refreshIntervalMs?: number;
  /** Overridden in tests so day bucketing does not depend on the host's zone. */
  readonly timeZone?: string;
  /**
   * Reads the machine's model aliases. Called on every fold rather than once
   * at construction, so an edit takes effect on the next re-price with no
   * cache invalidation anywhere.
   */
  readonly readModelAliases?: () => Promise<ModelAliasMap>;
}

export const makeCliUsageStore = (options: MakeCliUsageStoreOptions): CliUsageStoreShape => {
  const homeDir = options.homeDir ?? NodeOS.homedir();
  const refreshIntervalMs = options.refreshIntervalMs ?? CLI_USAGE_REFRESH_INTERVAL_MS;
  const toDay = makeDayBucketer(options.timeZone);
  const readModelAliases = options.readModelAliases ?? (() => Promise.resolve(EMPTY_MODEL_ALIASES));

  const cache = new Map<string, CachedFile>();
  let cacheLoaded = false;
  let latest: CliHistoricalUsage = {
    status: "scanning",
    computedAt: null,
    providers: [],
    totals: {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      messages: 0,
      unpricedMessages: 0,
    },
    filesScanned: 0,
  };
  // Tracked as a flag rather than inferred from `lastCompletedAtMs`: zero is a
  // legitimate instant (and the one a test clock starts at), so overloading it
  // as "never ran" makes a completed pass look stale on every read.
  let hasCompletedPass = false;
  let lastCompletedAtMs = 0;
  let inFlight: Promise<void> | null = null;

  const loadCache = async (): Promise<void> => {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const contents = await NodeFSP.readFile(options.cachePath, "utf8");
      const parsed: unknown = JSON.parse(contents);
      if (typeof parsed !== "object" || parsed === null) return;
      const file = parsed as Partial<CacheFile>;
      // A cache written by a build with different pricing or a different row
      // shape is discarded, not migrated. It is derived data; rebuilding it
      // costs one slow pass.
      if (file.version !== CACHE_VERSION || typeof file.files !== "object" || file.files === null) {
        return;
      }
      for (const [path, entry] of Object.entries(file.files)) {
        const decoded = decodeEntry(entry);
        if (decoded !== null) cache.set(path, decoded);
      }
    } catch {
      // No cache, unreadable cache, malformed cache: all mean "start cold".
    }
  };

  const saveCache = async (): Promise<void> => {
    const payload: CacheFile = {
      version: CACHE_VERSION,
      files: Object.fromEntries([...cache].map(([path, entry]) => encodeEntry(path, entry))),
    };
    const temporaryPath = `${options.cachePath}.${process.pid}.tmp`;
    try {
      await NodeFSP.writeFile(temporaryPath, JSON.stringify(payload), "utf8");
      // Rename is atomic within a filesystem, so a reader never sees a half
      // written cache — and a crash mid-write leaves the previous one intact.
      await NodeFSP.rename(temporaryPath, options.cachePath);
    } catch {
      await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  };

  /** Parses `files` with bounded concurrency, re-using unchanged cache entries. */
  const parseAll = async (
    files: ReadonlyArray<{
      readonly path: string;
      readonly provider: CliUsageProvider;
      readonly mtimeMs: number;
      readonly sizeBytes: number;
    }>,
  ): Promise<void> => {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= files.length) return;
        const file = files[index];
        if (file === undefined) return;
        const cached = cache.get(file.path);
        if (
          cached !== undefined &&
          cached.mtimeMs === file.mtimeMs &&
          cached.sizeBytes === file.sizeBytes
        ) {
          continue;
        }
        const parsed = await parseSessionFile(file.provider, file.path, toDay).catch(
          // One unreadable file must not lose the other four thousand.
          () => EMPTY_PARSED_FILE_USAGE,
        );
        cache.set(file.path, {
          provider: file.provider,
          mtimeMs: file.mtimeMs,
          sizeBytes: file.sizeBytes,
          parsed,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, files.length) }, worker));
  };

  /**
   * Every path the last pass counted, in scan order.
   *
   * Kept beside the cache so a re-price folds exactly the same file set the
   * pass did — the cache also holds entries the scan has not yet discarded,
   * and folding those would quietly resurrect a deleted store's spend.
   */
  let lastScannedPaths: ReadonlyArray<string> = [];
  let lastCodexPriorityTier = false;

  /**
   * Folds the parsed cache into `latest`. Pure arithmetic over what is already
   * in memory: no scan, no parse, no disk.
   */
  const foldFromCache = (nowMs: number, modelAliases: ModelAliasMap): void => {
    const parsedFiles: Array<ProviderFileUsage> = [];
    for (const path of lastScannedPaths) {
      const cached = cache.get(path);
      if (cached !== undefined) {
        parsedFiles.push({ provider: cached.provider, parsed: cached.parsed });
      }
    }

    const aggregate = aggregateCliUsage(parsedFiles, {
      today: toDay.fromMillis(nowMs),
      earliest7Day: dayOffsetFrom(nowMs, 6, toDay),
      earliest30Day: dayOffsetFrom(nowMs, 29, toDay),
      codexPriorityTier: lastCodexPriorityTier,
      modelAliases,
    });

    latest = {
      status: "ready",
      computedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      providers: aggregate.providers,
      totals: aggregate.totals,
      filesScanned: lastScannedPaths.length,
    };
  };

  const runRefresh = async (nowMs: number): Promise<void> => {
    await loadCache();
    const [files, codexPriorityTier, modelAliases] = await Promise.all([
      scanSessionFiles(homeDir),
      readCodexPriorityTier(homeDir),
      readModelAliases(),
    ]);

    // Files that vanished since the last pass stop counting. Keeping them would
    // report spend from a store the user deleted.
    const live = new Set(files.map((file) => file.path));
    const stale: Array<string> = [];
    for (const path of cache.keys()) {
      if (!live.has(path)) stale.push(path);
    }
    for (const path of stale) cache.delete(path);

    await parseAll(files);

    lastScannedPaths = files.map((file) => file.path);
    lastCodexPriorityTier = codexPriorityTier;
    foldFromCache(nowMs, modelAliases);

    lastCompletedAtMs = nowMs;
    hasCompletedPass = true;
    await saveCache();
  };

  const runReprice = async (nowMs: number): Promise<void> => {
    // Nothing to re-price yet, and a pass is what would produce something.
    if (!hasCompletedPass) return startRefresh(nowMs);
    // A refresh in flight is about to fold with fresh aliases of its own;
    // racing it would either be redundant or overwrite the newer answer.
    if (inFlight !== null) return inFlight;
    foldFromCache(nowMs, await readModelAliases());
  };

  const startRefresh = (nowMs: number): Promise<void> => {
    if (inFlight !== null) return inFlight;
    if (hasCompletedPass && nowMs - lastCompletedAtMs < refreshIntervalMs) {
      return Promise.resolve();
    }
    inFlight = runRefresh(nowMs)
      .catch(() => {
        // A store that cannot be walked at all leaves whatever the last pass
        // knew in place, and says so rather than reporting zero.
        if (!hasCompletedPass) latest = { ...latest, status: "failed" };
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    current: Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
      Effect.sync(() => {
        // Fire and forget: the caller gets the previous answer now, and a
        // fresher one on its next poll.
        void startRefresh(nowMs);
        return latest;
      }),
    ),
    refresh: Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
      Effect.promise(() => startRefresh(nowMs)),
    ),
    reprice: Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
      Effect.promise(() => runReprice(nowMs)),
    ),
  };
};

export const layer: Layer.Layer<
  CliUsageStore,
  never,
  ServerConfig.ServerConfig | CliUsageModelAliasRegistry
> = Layer.effect(
  CliUsageStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const aliases = yield* CliUsageModelAliasRegistry;
    // The store's refresh is a plain promise chain — it predates this and is
    // deliberately outside Effect so it can be fired and forgotten from a
    // request — so the registry read is run against the surrounding services
    // rather than a fresh runtime.
    const runWithContext = Effect.runPromiseWith(yield* Effect.context<never>());
    const readAliases = aliases.list.pipe(
      Effect.map(toModelAliasMap),
      // An unreadable registry costs the aliases, not the aggregate: the pass
      // still runs and still reports every vendored price it knows.
      Effect.orElseSucceed(() => EMPTY_MODEL_ALIASES),
    );
    return CliUsageStore.of(
      makeCliUsageStore({
        cachePath: config.cliUsageCachePath,
        readModelAliases: () => runWithContext(readAliases),
      }),
    );
  }),
);
