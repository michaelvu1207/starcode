/**
 * ProjectCatalogRegistry — this machine's half of the project categories.
 *
 * A JSON file under the state dir, mirroring `peers.json` and
 * `history-imports.json`, and deliberately not a table. Making category
 * membership an event would mean a new aggregate or a new thread meta field:
 * contracts, decider, projector and a migration, in the one area of this fork
 * where every edit is an append-only conflict. A category is metadata about a
 * workspace — there is nothing here to replay, audit, or undo.
 *
 * **What this file is not.** It is not the whole catalog. Every machine holds a
 * record per slug and the client unions them; this server only ever authors its
 * own copy. So `remove` removes locally and nothing else, and `upsert` patches
 * halves independently — the fan-out that makes four machines agree lives in
 * the client, which already fans reads out and can fan a write out the same way.
 *
 * @module ProjectCatalogRegistry
 */
import {
  DEFAULT_PROJECT_CATEGORY_MASTER_DEFAULTS,
  ProjectCategoryRecord,
  type ProjectCatalogFileThreadRequest,
  type ProjectCatalogUpsertRequest,
  type ProjectCategorySlug,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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

export class ProjectCatalogRegistryError extends Schema.TaggedErrorClass<ProjectCatalogRegistryError>()(
  "ProjectCatalogRegistryError",
  {
    operation: Schema.Literals(["load", "save"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the project catalog.`;
  }
}

const ProjectCatalogRegistryFile = Schema.Struct({
  version: Schema.Literal(1),
  categories: Schema.Array(ProjectCategoryRecord),
});
type ProjectCatalogRegistryFile = typeof ProjectCatalogRegistryFile.Type;

const decodeRegistryFile = Schema.decodeUnknownEffect(fromLenientJson(ProjectCatalogRegistryFile));
const encodeRegistryFile = Schema.encodeUnknownEffect(
  fromJsonStringPretty(ProjectCatalogRegistryFile),
);

const EMPTY_REGISTRY: ProjectCatalogRegistryFile = { version: 1, categories: [] };

export const formatCatalogTimestamp = (millis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

const uniqueThreadIds = (ids: ReadonlyArray<ThreadId>): ReadonlyArray<ThreadId> => [
  ...new Set(ids),
];

/**
 * The stamp on a display half nobody authored.
 *
 * The fold resolves display conflicts on newest `updatedAt`, so a placeholder
 * has to carry a time that cannot beat a real write. The epoch is the honest
 * value: this half is not an opinion about the title, it is the absence of one.
 */
export const PROVISIONAL_DISPLAY_UPDATED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Applies one upsert to a set of categories.
 *
 * Pure, and separate from the file handling, because every interesting rule
 * lives here: an absent half is untouched, a new slug is created with the
 * defaults a category starts life with, and `boundAt` survives a bindings
 * rewrite that still contains the same location.
 */
export function applyUpsert(input: {
  readonly categories: ReadonlyArray<ProjectCategoryRecord>;
  readonly request: ProjectCatalogUpsertRequest;
  readonly nowIso: string;
}): {
  readonly categories: ReadonlyArray<ProjectCategoryRecord>;
  readonly category: ProjectCategoryRecord;
  readonly created: boolean;
} {
  const existing = input.categories.find((entry) => entry.slug === input.request.slug) ?? null;
  const displayPatch = input.request.display;
  const localPatch = input.request.local;
  // The client stamps one authoring time and sends it to every machine, so a
  // rename converges on the operator's clock rather than racing on four.
  const displayUpdatedAt = input.request.displayUpdatedAt ?? input.nowIso;

  const base: ProjectCategoryRecord = existing ?? {
    slug: input.request.slug,
    createdAt: input.nowIso,
    display: {
      // A category created by an agent or a curl with no title reads as its
      // slug, which is a name, rather than as an empty row.
      title: input.request.slug,
      summary: "",
      accent: "",
      glyph: "",
      parentSlug: null,
      links: [],
      notes: "",
      archivedAt: null,
      // Deliberately the weakest stamp there is, not the write's own clock.
      //
      // A *local* write can create this record — binding a folder, or naming a
      // master, on a machine that missed the category's creation — and the
      // record it creates needs a display half to be well-formed. Stamping that
      // half with "now" made the placeholder the newest opinion in the fleet,
      // so the fold picked it and the project's title reverted to its raw slug
      // on every machine, listing the machines that had the real title as the
      // stale ones. A placeholder must lose to every real display write,
      // including one made a year ago.
      //
      // If it turns out to be the only copy anywhere, it still wins by being
      // the only one, which is the "reads as its slug" behaviour above.
      updatedAt: PROVISIONAL_DISPLAY_UPDATED_AT,
    },
    local: {
      bindings: [],
      threadIds: [],
      excludedThreadIds: [],
      masterThreadId: "",
      masterDefaults: DEFAULT_PROJECT_CATEGORY_MASTER_DEFAULTS,
      defaults: {},
      updatedAt: input.nowIso,
    },
  };

  const display =
    displayPatch === undefined
      ? base.display
      : {
          ...base.display,
          ...displayPatch,
          updatedAt: displayUpdatedAt,
        };

  const local =
    localPatch === undefined
      ? base.local
      : {
          ...base.local,
          ...(localPatch.bindings === undefined
            ? {}
            : {
                bindings: [...new Set(localPatch.bindings)].map((projectId: ProjectId) => ({
                  projectId,
                  // A rewrite that keeps a location keeps when it was bound —
                  // "bound since" is the kind of fact a rebind should not reset.
                  boundAt:
                    base.local.bindings.find((binding) => binding.projectId === projectId)
                      ?.boundAt ?? input.nowIso,
                })),
              }),
          ...(localPatch.threadIds === undefined
            ? {}
            : { threadIds: uniqueThreadIds(localPatch.threadIds) }),
          ...(localPatch.excludedThreadIds === undefined
            ? {}
            : { excludedThreadIds: uniqueThreadIds(localPatch.excludedThreadIds) }),
          ...(localPatch.masterThreadId === undefined
            ? {}
            : { masterThreadId: localPatch.masterThreadId.trim() }),
          ...(localPatch.masterDefaults === undefined
            ? {}
            : { masterDefaults: localPatch.masterDefaults }),
          ...(localPatch.defaults === undefined ? {} : { defaults: localPatch.defaults }),
          updatedAt: input.nowIso,
        };

  const category: ProjectCategoryRecord = { ...base, display, local };
  const categories =
    existing === null
      ? [...input.categories, category]
      : input.categories.map((entry) => (entry.slug === category.slug ? category : entry));

  return { categories, category, created: existing === null };
}

/**
 * Applies one filing decision.
 *
 * `assign` is the only operation that touches more than one category, and it
 * has to: a thread belongs to one project, so filing it into A means retracting
 * every other category's claim on it. Excluding is per-category by nature — it
 * only ever means "this bound location does not speak for this thread".
 */
export function applyFileThread(input: {
  readonly categories: ReadonlyArray<ProjectCategoryRecord>;
  readonly request: ProjectCatalogFileThreadRequest;
  readonly nowIso: string;
}): ReadonlyArray<ProjectCategoryRecord> {
  const { request, nowIso } = input;

  const rewrite = (
    category: ProjectCategoryRecord,
    next: {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly excluded: ReadonlyArray<ThreadId>;
    },
  ): ProjectCategoryRecord => {
    const unchanged =
      next.threadIds.length === category.local.threadIds.length &&
      next.excluded.length === category.local.excludedThreadIds.length &&
      next.threadIds.every((id, index) => category.local.threadIds[index] === id) &&
      next.excluded.every((id, index) => category.local.excludedThreadIds[index] === id);
    // Not merely an optimisation: leaving `local.updatedAt` alone on the
    // categories a write did not actually change is what keeps "when did this
    // machine last say something about this category" honest.
    if (unchanged) return category;
    return {
      ...category,
      local: {
        ...category.local,
        threadIds: next.threadIds,
        excludedThreadIds: next.excluded,
        updatedAt: nowIso,
      },
    };
  };

  const withoutThread = (ids: ReadonlyArray<ThreadId>) =>
    ids.filter((id) => id !== request.threadId);

  if (request.mode === "unfile") {
    return input.categories.map((category) =>
      rewrite(category, {
        threadIds: withoutThread(category.local.threadIds),
        excluded: withoutThread(category.local.excludedThreadIds),
      }),
    );
  }

  if (request.mode === "exclude") {
    return input.categories.map((category) =>
      category.slug === request.slug
        ? rewrite(category, {
            threadIds: withoutThread(category.local.threadIds),
            excluded: category.local.excludedThreadIds.includes(request.threadId)
              ? category.local.excludedThreadIds
              : [...category.local.excludedThreadIds, request.threadId],
          })
        : category,
    );
  }

  return input.categories.map((category) =>
    category.slug === request.slug
      ? rewrite(category, {
          threadIds: category.local.threadIds.includes(request.threadId)
            ? category.local.threadIds
            : [...category.local.threadIds, request.threadId],
          // Assigning overrides an earlier exclusion rather than fighting it.
          excluded: withoutThread(category.local.excludedThreadIds),
        })
      : rewrite(category, {
          threadIds: withoutThread(category.local.threadIds),
          excluded: category.local.excludedThreadIds,
        }),
  );
}

export interface ProjectCatalogRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<ProjectCategoryRecord>, ProjectCatalogRegistryError>;
  readonly find: (
    slug: ProjectCategorySlug,
  ) => Effect.Effect<Option.Option<ProjectCategoryRecord>, ProjectCatalogRegistryError>;
  readonly upsert: (
    request: ProjectCatalogUpsertRequest,
  ) => Effect.Effect<
    { readonly category: ProjectCategoryRecord; readonly created: boolean },
    ProjectCatalogRegistryError
  >;
  readonly remove: (
    slug: ProjectCategorySlug,
  ) => Effect.Effect<boolean, ProjectCatalogRegistryError>;
  readonly fileThread: (
    request: ProjectCatalogFileThreadRequest,
  ) => Effect.Effect<ReadonlyArray<ProjectCategoryRecord>, ProjectCatalogRegistryError>;
}

export class ProjectCatalogRegistry extends Context.Service<
  ProjectCatalogRegistry,
  ProjectCatalogRegistryShape
>()("t3/projectCatalog/ProjectCatalogRegistry") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  // One writer at a time. Every write here is read-modify-write over the whole
  // file, so two concurrent upserts without this would not merge — the later
  // one would write a set that never saw the earlier one's category.
  const writeSemaphore = yield* Semaphore.make(1);

  const readFile: Effect.Effect<ProjectCatalogRegistryFile, ProjectCatalogRegistryError> = fs
    .readFileString(config.projectCatalogPath)
    .pipe(
      Effect.map(Option.some),
      // No file is the normal state of a machine nobody has filed anything on.
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new ProjectCatalogRegistryError({ operation: "load", cause })),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(EMPTY_REGISTRY),
          onSome: (contents) =>
            decodeRegistryFile(contents).pipe(
              Effect.mapError(
                (cause) => new ProjectCatalogRegistryError({ operation: "load", cause }),
              ),
            ),
        }),
      ),
    );

  const writeFile = (categories: ReadonlyArray<ProjectCategoryRecord>) =>
    encodeRegistryFile({ version: 1, categories } satisfies ProjectCatalogRegistryFile).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: config.projectCatalogPath,
          contents: `${contents}\n`,
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new ProjectCatalogRegistryError({ operation: "save", cause })),
    );

  const list = readFile.pipe(Effect.map((file) => file.categories));

  const nowIso = Clock.currentTimeMillis.pipe(Effect.map(formatCatalogTimestamp));

  return {
    list,
    find: (slug) =>
      list.pipe(
        Effect.map((categories) =>
          Option.fromNullishOr(categories.find((entry) => entry.slug === slug)),
        ),
      ),
    upsert: (request) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const file = yield* readFile;
          const applied = applyUpsert({
            categories: file.categories,
            request,
            nowIso: yield* nowIso,
          });
          yield* writeFile(applied.categories);
          return { category: applied.category, created: applied.created };
        }),
      ),
    remove: (slug) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const file = yield* readFile;
          const remaining = file.categories.filter((entry) => entry.slug !== slug);
          if (remaining.length === file.categories.length) return false;
          yield* writeFile(remaining);
          return true;
        }),
      ),
    fileThread: (request) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const file = yield* readFile;
          const categories = applyFileThread({
            categories: file.categories,
            request,
            nowIso: yield* nowIso,
          });
          yield* writeFile(categories);
          return categories;
        }),
      ),
  } satisfies ProjectCatalogRegistryShape;
});

export const layer: Layer.Layer<
  ProjectCatalogRegistry,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
> = Layer.effect(ProjectCatalogRegistry, make);
