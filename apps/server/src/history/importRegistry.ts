/**
 * HistoryImportRegistry - where a thread's conversation came from.
 *
 * A JSON file under the state dir, mirroring `peers.json`. Not a table, and
 * deliberately so: a thread has no free-form metadata field, adding one is a
 * six-file change across contracts, decider, projector and a migration, and
 * migrations are the highest-risk edit this fork makes. Provenance for a
 * feature that writes at most a handful of rows a week does not justify that.
 *
 * Two kinds of row, one file. An import row says a thread's conversation came
 * from a CLI session on this machine's disk; a fork row says it came from
 * another thread here. They are kept together because every reader wants both
 * — a thread view asking "where did this come from?" should not have to ask
 * twice and render its answer a frame late — and separated into two arrays
 * because they are keyed differently: imports by the history session they
 * claim (one row per session, re-import replaces), forks by the thread they
 * created (one row per fork, and a thread can be forked repeatedly).
 *
 * The registry is not the link itself. The authoritative binding is the resume
 * cursor on `provider_session_runtime`, which is what actually makes a thread
 * resume — or, for a fork, what makes the provider fork rather than start
 * fresh. This file exists so the picker can say "already imported — open it"
 * without reading every thread's binding, and so an imported or forked thread
 * can say what it inherited. A stale row (thread deleted outside t3) is a
 * cheap lookup rather than a lie: callers check the projection before
 * honouring an entry.
 *
 * @module HistoryImportRegistry
 */
import {
  HistoryForkRecord,
  HistoryImportRecord,
  type HistorySessionId,
  type ThreadId,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

export class HistoryImportRegistryError extends Schema.TaggedErrorClass<HistoryImportRegistryError>()(
  "HistoryImportRegistryError",
  {
    operation: Schema.Literals(["load", "save"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the history import registry.`;
  }
}

const HistoryImportRegistryFile = Schema.Struct({
  version: Schema.Literal(1),
  imports: Schema.Array(HistoryImportRecord),
  /**
   * Optional, and the version stays at 1, because a file written before forks
   * were recorded is not a different version of this format — it is this
   * format with nothing in one of its arrays. Bumping the version would mean
   * writing a migration for a file whose only difference is an absent key.
   */
  forks: Schema.optionalKey(Schema.Array(HistoryForkRecord)),
});
type HistoryImportRegistryFile = typeof HistoryImportRegistryFile.Type;

const decodeRegistryFile = Schema.decodeUnknownEffect(fromLenientJson(HistoryImportRegistryFile));
const encodeRegistryFile = Schema.encodeUnknownEffect(
  fromJsonStringPretty(HistoryImportRegistryFile),
);

const EMPTY_REGISTRY: HistoryImportRegistryFile = { version: 1, imports: [] };

export interface HistoryImportRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<HistoryImportRecord>, HistoryImportRegistryError>;
  readonly find: (
    historySessionId: HistorySessionId,
  ) => Effect.Effect<Option.Option<HistoryImportRecord>, HistoryImportRegistryError>;
  /**
   * Records an import, replacing any earlier row for the same session.
   *
   * Last write wins rather than first: a row only gets replaced when an import
   * ran, and an import only runs when the caller was told the previous thread
   * was gone.
   */
  readonly record: (entry: HistoryImportRecord) => Effect.Effect<void, HistoryImportRegistryError>;
  readonly listForks: Effect.Effect<ReadonlyArray<HistoryForkRecord>, HistoryImportRegistryError>;
  /**
   * Records a fork, replacing any earlier row for the same *fork* thread.
   *
   * Keyed on the thread created rather than the thread forked, because one
   * conversation can be forked as often as someone wants to try a different
   * direction from it — and each of those forks needs its own provenance line.
   */
  readonly recordFork: (
    entry: HistoryForkRecord,
  ) => Effect.Effect<void, HistoryImportRegistryError>;
  /** Which thread, if any, this fork was taken from. */
  readonly findFork: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<HistoryForkRecord>, HistoryImportRegistryError>;
}

export class HistoryImportRegistry extends Context.Service<
  HistoryImportRegistry,
  HistoryImportRegistryShape
>()("t3/history/importRegistry/HistoryImportRegistry") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  // One writer at a time. Two imports racing on the same machine is unlikely
  // but the failure mode — one of them silently dropping the other's row —
  // is exactly what provenance must not do.
  const writeSemaphore = yield* Semaphore.make(1);

  const readFile: Effect.Effect<HistoryImportRegistryFile, HistoryImportRegistryError> = fs
    .readFileString(config.historyImportsPath)
    .pipe(
      Effect.map(Option.some),
      // No file is the normal state of a machine that has never imported.
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new HistoryImportRegistryError({ operation: "load", cause })),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(EMPTY_REGISTRY),
          onSome: (contents) =>
            decodeRegistryFile(contents).pipe(
              Effect.mapError(
                (cause) => new HistoryImportRegistryError({ operation: "load", cause }),
              ),
            ),
        }),
      ),
    );

  const writeFile = (next: HistoryImportRegistryFile) =>
    encodeRegistryFile(next).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: config.historyImportsPath,
          contents: `${contents}\n`,
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new HistoryImportRegistryError({ operation: "save", cause })),
    );

  const list = readFile.pipe(Effect.map((file) => file.imports));
  const listForks = readFile.pipe(Effect.map((file) => file.forks ?? []));

  /**
   * Both writers re-read under the semaphore and write the whole file, so a
   * fork recorded while an import is in flight cannot drop the import's row.
   * `forks` is only ever written back when it has something in it, which keeps
   * a machine that has never forked producing exactly the file it produced
   * before this field existed.
   */
  const rewrite = (
    update: (file: HistoryImportRegistryFile) => HistoryImportRegistryFile,
  ): Effect.Effect<void, HistoryImportRegistryError> =>
    writeSemaphore.withPermits(1)(
      readFile.pipe(
        Effect.flatMap((file) => {
          const next = update(file);
          return writeFile(
            next.forks === undefined || next.forks.length === 0
              ? { version: 1, imports: next.imports }
              : next,
          );
        }),
      ),
    );

  return {
    list,
    find: (historySessionId) =>
      list.pipe(
        Effect.map((imports) =>
          Option.fromNullishOr(
            imports.find((entry) => entry.historySessionId === historySessionId),
          ),
        ),
      ),
    record: (entry) =>
      rewrite((file) => ({
        ...file,
        imports: [
          ...file.imports.filter(
            (existing) => existing.historySessionId !== entry.historySessionId,
          ),
          entry,
        ],
      })),
    listForks,
    findFork: (threadId) =>
      listForks.pipe(
        Effect.map((forks) =>
          Option.fromNullishOr(forks.find((entry) => entry.threadId === threadId)),
        ),
      ),
    recordFork: (entry) =>
      rewrite((file) => ({
        ...file,
        forks: [
          ...(file.forks ?? []).filter((existing) => existing.threadId !== entry.threadId),
          entry,
        ],
      })),
  } satisfies HistoryImportRegistryShape;
});

export const layer: Layer.Layer<
  HistoryImportRegistry,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
> = Layer.effect(HistoryImportRegistry, make);
