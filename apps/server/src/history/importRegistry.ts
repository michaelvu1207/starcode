/**
 * HistoryImportRegistry - which CLI session became which thread.
 *
 * A JSON file under the state dir, mirroring `peers.json`. Not a table, and
 * deliberately so: a thread has no free-form metadata field, adding one is a
 * six-file change across contracts, decider, projector and a migration, and
 * migrations are the highest-risk edit this fork makes. Provenance for a
 * feature that writes at most a handful of rows a week does not justify that.
 *
 * The registry is not the link itself. The authoritative binding between a
 * thread and a foreign session is the resume cursor on
 * `provider_session_runtime`, which is what actually makes the thread resume.
 * This file exists so the import picker can say "already imported — open it"
 * without reading every thread's binding, and so a stale row (thread deleted
 * outside t3) is a cheap lookup rather than a lie: callers check the
 * projection before honouring an entry.
 *
 * @module HistoryImportRegistry
 */
import { HistoryImportRecord, type HistorySessionId } from "@t3tools/contracts";
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
      writeSemaphore.withPermits(1)(
        readFile.pipe(
          Effect.flatMap((file) =>
            writeFile({
              version: 1,
              imports: [
                ...file.imports.filter(
                  (existing) => existing.historySessionId !== entry.historySessionId,
                ),
                entry,
              ],
            }),
          ),
        ),
      ),
  } satisfies HistoryImportRegistryShape;
});

export const layer: Layer.Layer<
  HistoryImportRegistry,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
> = Layer.effect(HistoryImportRegistry, make);
