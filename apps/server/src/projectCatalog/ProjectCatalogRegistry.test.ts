import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectCategorySlug,
  ProjectId,
  ThreadId,
  type ProjectCatalogUpsertRequest,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import {
  applyFileThread,
  applyUpsert,
  ProjectCatalogRegistry,
  layer as projectCatalogRegistryLayer,
  PROVISIONAL_DISPLAY_UPDATED_AT,
} from "./ProjectCatalogRegistry.ts";

const makeLayer = () =>
  projectCatalogRegistryLayer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "starcode-project-catalog-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const slug = (value: string) => ProjectCategorySlug.make(value);
const thread = (value: string) => ThreadId.make(value);
const project = (value: string) => ProjectId.make(value);

const upsert = (
  overrides: Partial<ProjectCatalogUpsertRequest> & {
    readonly slug: ProjectCatalogUpsertRequest["slug"];
  },
): ProjectCatalogUpsertRequest => overrides;

it.effect("reports nothing, and writes nothing, before the first category", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    assert.deepEqual([...(yield* registry.list)], []);
    assert.isTrue(Option.isNone(yield* registry.find(slug("alpamayo"))));
    // A machine nobody has filed anything on has no file at all — the catalog
    // is a side effect of filing, not a schema every server ships with.
    assert.isFalse(yield* fileSystem.exists(config.projectCatalogPath));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("round-trips a category through the file", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;

    const created = yield* registry.upsert(
      upsert({
        slug: slug("alpamayo"),
        display: { title: "Alpamayo", summary: "sim2real" },
        local: { bindings: [project("project-1")], masterThreadId: "thread-master" },
      }),
    );
    assert.isTrue(created.created);

    const found = yield* registry.find(slug("alpamayo"));
    assert.isTrue(Option.isSome(found));
    const record = Option.getOrThrow(found);
    assert.equal(record.display.title, "Alpamayo");
    assert.equal(record.display.summary, "sim2real");
    assert.equal(record.local.masterThreadId, "thread-master");
    assert.deepEqual(
      record.local.bindings.map((binding) => binding.projectId),
      [project("project-1")],
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("names a category after its slug until someone titles it", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const { category } = yield* registry.upsert(upsert({ slug: slug("render-fleet") }));
    assert.equal(category.display.title, "render-fleet");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("patches one half without touching the other", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    yield* registry.upsert(
      upsert({
        slug: slug("alpamayo"),
        display: { title: "Alpamayo" },
        local: { bindings: [project("project-1")], masterThreadId: "thread-master" },
      }),
    );

    // A fan-out write from another machine carries display only. It must not
    // arrive as "and this machine binds nothing and designates no master".
    const renamed = yield* registry.upsert(
      upsert({ slug: slug("alpamayo"), display: { title: "Alpamayo Pipeline" } }),
    );
    assert.isFalse(renamed.created);
    assert.equal(renamed.category.display.title, "Alpamayo Pipeline");
    assert.equal(renamed.category.local.masterThreadId, "thread-master");
    assert.lengthOf(renamed.category.local.bindings, 1);

    // And the reverse: a local membership write must not blank the title.
    const rebound = yield* registry.upsert(
      upsert({ slug: slug("alpamayo"), local: { threadIds: [thread("thread-7")] } }),
    );
    assert.equal(rebound.category.display.title, "Alpamayo Pipeline");
    assert.deepEqual([...rebound.category.local.threadIds], [thread("thread-7")]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps the slug and creation time across a rename", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const first = yield* registry.upsert(
      upsert({ slug: slug("alpamayo"), display: { title: "Alpamayo" } }),
    );
    const renamed = yield* registry.upsert(
      upsert({ slug: slug("alpamayo"), display: { title: "Alpamayo Pipeline" } }),
    );

    assert.equal(renamed.category.slug, first.category.slug);
    assert.equal(renamed.category.createdAt, first.category.createdAt);
    assert.lengthOf(yield* registry.list, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("honours the caller's authoring timestamp for display writes", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const authoredAt = "2026-07-25T12:00:00.000Z";
    const { category } = yield* registry.upsert(
      upsert({
        slug: slug("alpamayo"),
        display: { title: "Alpamayo" },
        displayUpdatedAt: authoredAt,
      }),
    );
    // The fold breaks title ties on this value, so a fan-out has to be able to
    // put the same one on four machines with four clocks.
    assert.equal(category.display.updatedAt, authoredAt);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("serializes concurrent upserts instead of dropping one", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;

    yield* Effect.all(
      [
        registry.upsert(upsert({ slug: slug("alpha"), display: { title: "Alpha" } })),
        registry.upsert(upsert({ slug: slug("beta"), display: { title: "Beta" } })),
        registry.upsert(upsert({ slug: slug("gamma"), display: { title: "Gamma" } })),
      ],
      { concurrency: "unbounded" },
    );

    const slugs = (yield* registry.list).map((entry) => entry.slug).toSorted();
    assert.deepEqual(slugs, [slug("alpha"), slug("beta"), slug("gamma")]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("treats removing an unknown slug as a no-op, not a failure", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    yield* registry.upsert(upsert({ slug: slug("alpamayo") }));

    assert.isFalse(yield* registry.remove(slug("never-existed")));
    assert.isTrue(yield* registry.remove(slug("alpamayo")));
    assert.deepEqual([...(yield* registry.list)], []);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("removes the record and nothing else — no thread, no folder, no other category", () =>
  Effect.gen(function* () {
    // Invariant 1, pinned where it is cheapest to pin: the registry writes one
    // file, so "deleting a project touches nothing else" is observable as the
    // rest of that file surviving intact, ids and all.
    const registry = yield* ProjectCatalogRegistry;
    yield* registry.upsert(
      upsert({
        slug: slug("alpamayo"),
        local: {
          bindings: [project("project-1")],
          threadIds: [thread("t1")],
          masterThreadId: "thread-master",
        },
      }),
    );
    const survivor = yield* registry.upsert(
      upsert({
        slug: slug("simcloud"),
        display: { title: "SimCloud" },
        local: { bindings: [project("project-2")], threadIds: [thread("t2")] },
      }),
    );

    assert.isTrue(yield* registry.remove(slug("alpamayo")));

    const remaining = yield* registry.list;
    assert.lengthOf(remaining, 1);
    assert.deepEqual(remaining[0], survivor.category);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("moves a thread between categories in one write", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    yield* registry.upsert(upsert({ slug: slug("alpha") }));
    yield* registry.upsert(upsert({ slug: slug("beta") }));

    yield* registry.fileThread({ mode: "assign", threadId: thread("t1"), slug: slug("alpha") });
    const moved = yield* registry.fileThread({
      mode: "assign",
      threadId: thread("t1"),
      slug: slug("beta"),
    });

    const byslug = new Map(moved.map((entry) => [entry.slug, entry]));
    assert.deepEqual([...byslug.get(slug("alpha"))!.local.threadIds], []);
    assert.deepEqual([...byslug.get(slug("beta"))!.local.threadIds], [thread("t1")]);
  }).pipe(Effect.provide(makeLayer())),
);

it("assign clears an earlier exclusion on the same category", () => {
  const nowIso = "2026-07-25T00:00:00.000Z";
  const seeded = applyUpsert({
    categories: [],
    request: { slug: slug("alpha"), local: { excludedThreadIds: [thread("t1")] } },
    nowIso,
  });

  const assigned = applyFileThread({
    categories: seeded.categories,
    request: { mode: "assign", threadId: thread("t1"), slug: slug("alpha") },
    nowIso,
  });

  assert.deepEqual([...assigned[0]!.local.threadIds], [thread("t1")]);
  assert.deepEqual([...assigned[0]!.local.excludedThreadIds], []);
});

it("unfile drops every explicit opinion about the thread", () => {
  const nowIso = "2026-07-25T00:00:00.000Z";
  const seeded = applyUpsert({
    categories: applyUpsert({
      categories: [],
      request: { slug: slug("alpha"), local: { threadIds: [thread("t1")] } },
      nowIso,
    }).categories,
    request: { slug: slug("beta"), local: { excludedThreadIds: [thread("t1")] } },
    nowIso,
  });

  const unfiled = applyFileThread({
    categories: seeded.categories,
    request: { mode: "unfile", threadId: thread("t1"), slug: null },
    nowIso,
  });

  assert.deepEqual([...unfiled[0]!.local.threadIds], []);
  assert.deepEqual([...unfiled[1]!.local.excludedThreadIds], []);
});

it("leaves local.updatedAt alone on categories a filing did not change", () => {
  const seeded = applyUpsert({
    categories: [],
    request: { slug: slug("alpha") },
    nowIso: "2026-07-25T00:00:00.000Z",
  });

  const filed = applyFileThread({
    categories: seeded.categories,
    request: { mode: "assign", threadId: thread("t1"), slug: slug("beta") },
    nowIso: "2026-07-26T00:00:00.000Z",
  });

  // "alpha" never held the thread, so this machine has not said anything new
  // about it and its timestamp must not move.
  assert.equal(filed[0]!.local.updatedAt, "2026-07-25T00:00:00.000Z");
});

it("preserves boundAt for a location that survives a bindings rewrite", () => {
  const first = applyUpsert({
    categories: [],
    request: { slug: slug("alpha"), local: { bindings: [project("p1")] } },
    nowIso: "2026-07-25T00:00:00.000Z",
  });

  const second = applyUpsert({
    categories: first.categories,
    request: { slug: slug("alpha"), local: { bindings: [project("p1"), project("p2")] } },
    nowIso: "2026-07-26T00:00:00.000Z",
  });

  const bindings = new Map(
    second.category.local.bindings.map((binding) => [binding.projectId, binding.boundAt]),
  );
  assert.equal(bindings.get(project("p1")), "2026-07-25T00:00:00.000Z");
  assert.equal(bindings.get(project("p2")), "2026-07-26T00:00:00.000Z");
});

it.effect("stamps a placeholder display so it cannot outrank a real title", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;

    // A machine that missed the project's creation, binding a folder to it for
    // the first time. The record it creates needs a display half to be
    // well-formed — but stamping that half with "now" made the placeholder the
    // newest opinion in the fleet, so the fold picked it and the project's
    // title reverted to its raw slug on every machine.
    const bound = yield* registry.upsert(
      upsert({
        slug: slug("alpamayo"),
        local: { bindings: [project("project-1")] },
        displayUpdatedAt: "2026-07-25T00:00:00.000Z",
      }),
    );

    assert.isTrue(bound.created);
    assert.strictEqual(bound.category.display.title, "alpamayo");
    assert.strictEqual(bound.category.display.updatedAt, PROVISIONAL_DISPLAY_UPDATED_AT);
    // The property that matters is the comparison the fold makes: a placeholder
    // must lose to any real display write, including one from years ago.
    assert.isTrue(bound.category.display.updatedAt < "2026-07-25T00:00:00.000Z");
    // The write it was made for still landed.
    assert.lengthOf(bound.category.local.bindings, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("still stamps a real display write with the authoring clock", () =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const created = yield* registry.upsert(
      upsert({
        slug: slug("alpamayo"),
        display: { title: "Alpamayo Pipeline" },
        displayUpdatedAt: "2026-07-25T00:00:00.000Z",
      }),
    );

    assert.strictEqual(created.category.display.updatedAt, "2026-07-25T00:00:00.000Z");
    assert.strictEqual(created.category.display.title, "Alpamayo Pipeline");
  }).pipe(Effect.provide(makeLayer())),
);
