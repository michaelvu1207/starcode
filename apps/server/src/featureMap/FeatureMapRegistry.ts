/**
 * FeatureMapRegistry - the orchestrator's account of what is being built.
 *
 * A JSON file under the state dir, mirroring `peers.json` and
 * `history-imports.json`. Deliberately not a table: a migration is the highest
 * risk edit this fork makes, and a file that takes a handful of writes a day
 * from one thread does not justify one. The same reasoning that kept the import
 * registry out of SQLite applies here with less traffic.
 *
 * Every mutation is read-modify-write under a single permit. That is not
 * pessimism about concurrency — it is that the master can issue several tool
 * calls in one turn, and two of them interleaving would drop one silently,
 * which is exactly what a record of intent must never do.
 *
 * @module FeatureMapRegistry
 */
import {
  FeatureMapEntry,
  FeatureMapEntryId,
  FeatureMapError,
  type FeatureCreateInput,
  type FeatureLinkInput,
  type FeaturePlanSetInput,
  type FeaturePromoteInput,
  type FeatureUpdateInput,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { nextStage, pruneDanglingLinks, resolvePlan, wouldCycle } from "./featureMap.logic.ts";

const FeatureMapFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(FeatureMapEntry),
});
type FeatureMapFile = typeof FeatureMapFile.Type;

const decodeFile = Schema.decodeUnknownEffect(fromLenientJson(FeatureMapFile));
const encodeFile = Schema.encodeUnknownEffect(fromJsonStringPretty(FeatureMapFile));

const EMPTY: FeatureMapFile = { version: 1, entries: [] };

export interface FeatureMapRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<FeatureMapEntry>, FeatureMapError>;
  readonly create: (input: FeatureCreateInput) => Effect.Effect<FeatureMapEntry, FeatureMapError>;
  readonly update: (input: FeatureUpdateInput) => Effect.Effect<FeatureMapEntry, FeatureMapError>;
  readonly promote: (input: FeaturePromoteInput) => Effect.Effect<FeatureMapEntry, FeatureMapError>;
  readonly link: (input: FeatureLinkInput) => Effect.Effect<FeatureMapEntry, FeatureMapError>;
  readonly planSet: (
    input: FeaturePlanSetInput,
  ) => Effect.Effect<
    { readonly entries: ReadonlyArray<FeatureMapEntry>; readonly removedCount: number },
    FeatureMapError
  >;
}

export class FeatureMapRegistry extends Context.Service<
  FeatureMapRegistry,
  FeatureMapRegistryShape
>()("t3/featureMap/FeatureMapRegistry") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const writeSemaphore = yield* Semaphore.make(1);

  const mintId = crypto.randomBytes(6).pipe(
    Effect.map((bytes) =>
      FeatureMapEntryId.make(
        Array.from(bytes)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      ),
    ),
    Effect.orDie,
  );

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readFile: Effect.Effect<FeatureMapFile, FeatureMapError> = fs
    .readFileString(config.featureMapPath)
    .pipe(
      Effect.map(Option.some),
      // No file is the normal state of a machine whose orchestrator has never
      // written anything down.
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new FeatureMapError({
                operation: "list",
                reason: "storage_failed",
                detail: String(cause),
              }),
            ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(EMPTY),
          onSome: (contents) =>
            decodeFile(contents).pipe(
              Effect.mapError(
                (cause) =>
                  new FeatureMapError({
                    operation: "list",
                    reason: "storage_failed",
                    detail: String(cause),
                  }),
              ),
            ),
        }),
      ),
    );

  const writeEntries = (entries: ReadonlyArray<FeatureMapEntry>) =>
    encodeFile({ version: 1, entries }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: config.featureMapPath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new FeatureMapError({
            operation: "create",
            reason: "storage_failed",
            detail: String(cause),
          }),
      ),
    );

  /** Every mutation is this shape: read, decide, write, return. */
  const mutate = <A>(
    decide: (
      entries: ReadonlyArray<FeatureMapEntry>,
      timestamp: string,
    ) => Effect.Effect<
      { readonly entries: ReadonlyArray<FeatureMapEntry>; readonly result: A },
      FeatureMapError
    >,
  ): Effect.Effect<A, FeatureMapError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const file = yield* readFile;
        const timestamp = yield* now;
        const decided = yield* decide(file.entries, timestamp);
        yield* writeEntries(decided.entries);
        return decided.result;
      }),
    );

  const require = (
    entries: ReadonlyArray<FeatureMapEntry>,
    id: FeatureMapEntryId,
    operation: FeatureMapError["operation"],
  ): Effect.Effect<FeatureMapEntry, FeatureMapError> => {
    const found = entries.find((entry) => entry.id === id);
    return found === undefined
      ? Effect.fail(
          new FeatureMapError({
            operation,
            reason: "not_found",
            detail: `Unknown feature ${id}.`,
          }),
        )
      : Effect.succeed(found);
  };

  const replace = (
    entries: ReadonlyArray<FeatureMapEntry>,
    next: FeatureMapEntry,
  ): ReadonlyArray<FeatureMapEntry> =>
    entries.map((entry) => (entry.id === next.id ? next : entry));

  return {
    list: readFile.pipe(Effect.map((file) => file.entries)),

    create: (input) =>
      mutate((entries, timestamp) =>
        Effect.gen(function* () {
          const id = yield* mintId;
          const known = new Set(entries.map((entry) => entry.id));
          // A link to something that is not there is dropped rather than
          // refused: the caller is describing a shape, and one bad reference
          // should not cost it the whole feature.
          const dependsOn = (input.dependsOn ?? []).filter((other) => known.has(other));
          const entry: FeatureMapEntry = {
            id,
            name: input.name,
            description: input.description ?? null,
            threadId: input.threadId ?? null,
            slug: input.slug ?? null,
            stage: input.stage ?? "in-progress",
            dependsOn,
            // A feature bound to a thread is by definition under way, whatever
            // the call said.
            planned: input.threadId === undefined && (input.planned ?? false),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          return { entries: [...entries, entry], result: entry };
        }),
      ),

    update: (input) =>
      mutate((entries, timestamp) =>
        Effect.gen(function* () {
          const existing = yield* require(entries, input.id, "update");
          const threadId = input.threadId === undefined ? existing.threadId : input.threadId;
          const next: FeatureMapEntry = {
            ...existing,
            name: input.name ?? existing.name,
            description: input.description === undefined ? existing.description : input.description,
            threadId,
            // Null is a meaningful value here — it unfiles the feature and hands
            // the question back to its thread — so absence is the only "leave
            // it alone", exactly as for `description` above.
            slug: input.slug === undefined ? existing.slug : input.slug,
            // Binding a thread is how intent becomes work; the call has to say
            // so explicitly to keep a feature planned once it has one.
            planned: input.planned ?? (threadId === null ? existing.planned : false),
            updatedAt: timestamp,
          };
          return { entries: replace(entries, next), result: next };
        }),
      ),

    promote: (input) =>
      mutate((entries, timestamp) =>
        Effect.gen(function* () {
          const existing = yield* require(entries, input.id, "promote");
          const target = input.stage ?? nextStage(existing.stage);
          if (target === null) {
            return yield* new FeatureMapError({
              operation: "promote",
              reason: "invalid",
              detail: `${existing.name} has already shipped; there is nowhere further to promote it.`,
            });
          }
          const next: FeatureMapEntry = { ...existing, stage: target, updatedAt: timestamp };
          return { entries: replace(entries, next), result: next };
        }),
      ),

    link: (input) =>
      mutate((entries, timestamp) =>
        Effect.gen(function* () {
          const existing = yield* require(entries, input.id, "link");
          const linked = input.linked ?? true;
          if (linked) {
            yield* require(entries, input.dependsOnId, "link");
            if (wouldCycle(entries, input.id, input.dependsOnId)) {
              return yield* new FeatureMapError({
                operation: "link",
                reason: "cycle",
                detail: "That link would make the features wait on each other.",
              });
            }
          }
          const dependsOn = linked
            ? existing.dependsOn.includes(input.dependsOnId)
              ? existing.dependsOn
              : [...existing.dependsOn, input.dependsOnId]
            : existing.dependsOn.filter((other) => other !== input.dependsOnId);
          const next: FeatureMapEntry = { ...existing, dependsOn, updatedAt: timestamp };
          return { entries: replace(entries, next), result: next };
        }),
      ),

    planSet: (input) =>
      mutate((entries, timestamp) =>
        Effect.gen(function* () {
          const resolved = resolvePlan(input.features);
          const slug = input.slug ?? null;
          // Real work is never touched by a plan. Only the previous sketch is
          // replaced, which is what makes re-planning safe to do repeatedly —
          // and when the call names a project, only *that* project's sketch,
          // so two project masters on one machine cannot delete each other's
          // plans without either of them being able to tell.
          const kept = entries.filter(
            (entry) => !entry.planned || (slug !== null && entry.slug !== slug),
          );
          const removedCount = entries.length - kept.length;

          const idByKey = new Map<string, FeatureMapEntryId>();
          for (const entry of resolved.entries) idByKey.set(entry.key, yield* mintId);

          const planned = resolved.entries.map(
            (entry): FeatureMapEntry => ({
              id: idByKey.get(entry.key)!,
              name: entry.name,
              description: entry.description,
              threadId: null,
              slug,
              stage: entry.stage,
              dependsOn: entry.dependsOnKeys.flatMap((key) => {
                const id = idByKey.get(key);
                return id === undefined ? [] : [id];
              }),
              planned: true,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          );

          const next = pruneDanglingLinks([...kept, ...planned]);
          return { entries: next, result: { entries: planned, removedCount } };
        }),
      ),
  } satisfies FeatureMapRegistryShape;
});

export const layer: Layer.Layer<
  FeatureMapRegistry,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Crypto.Crypto
> = Layer.effect(FeatureMapRegistry, make);
