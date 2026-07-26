import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectCategorySlug, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  FeatureMapRegistry,
  layer as featureMapRegistryLayer,
  make as makeFeatureMapRegistry,
} from "./FeatureMapRegistry.ts";

const makeLayer = () =>
  featureMapRegistryLayer.pipe(
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-feature-map-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("reports nothing, and writes nothing, before the orchestrator says anything", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    assert.deepEqual([...(yield* registry.list)], []);
    // A machine whose orchestrator has never written is a machine with no file.
    assert.isFalse(yield* fileSystem.exists(config.featureMapPath));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("creates a feature at the start of the chain and mints its own id", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const created = yield* registry.create({ name: "Star map" });

    assert.match(created.id, /^[0-9a-f]{12}$/);
    assert.strictEqual(created.stage, "in-progress");
    assert.strictEqual(created.planned, false);
    assert.deepEqual(
      [...(yield* registry.list)].map((entry) => entry.name),
      ["Star map"],
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("gives two features distinct ids", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const first = yield* registry.create({ name: "One" });
    const second = yield* registry.create({ name: "Two" });
    assert.notStrictEqual(first.id, second.id);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("treats a feature bound to a thread as real however the call was written", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const created = yield* registry.create({
      name: "Already running",
      threadId: ThreadId.make("thread-1"),
      planned: true,
    });
    assert.strictEqual(created.planned, false);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("promotes a feature one step, and refuses to promote a shipped one", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const created = yield* registry.create({ name: "Rising" });

    const dev = yield* registry.promote({ id: created.id });
    assert.strictEqual(dev.stage, "in-dev");
    const shipped = yield* registry.promote({ id: created.id, stage: "in-production" });
    assert.strictEqual(shipped.stage, "in-production");

    const refused = yield* registry.promote({ id: created.id }).pipe(Effect.flip);
    assert.strictEqual(refused.reason, "invalid");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses a promotion of something that is not on the map", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const refused = yield* registry.promote({ id: "abcabcabcabc" as never }).pipe(Effect.flip);
    assert.strictEqual(refused.reason, "not_found");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("links two features, and refuses a link that would close a loop", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const base = yield* registry.create({ name: "Base" });
    const stacked = yield* registry.create({ name: "Stacked" });

    const linked = yield* registry.link({ id: stacked.id, dependsOnId: base.id });
    assert.deepEqual([...linked.dependsOn], [base.id]);
    // Linking twice must not duplicate the edge.
    const again = yield* registry.link({ id: stacked.id, dependsOnId: base.id });
    assert.deepEqual([...again.dependsOn], [base.id]);

    const refused = yield* registry
      .link({ id: base.id, dependsOnId: stacked.id })
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "cycle");

    const unlinked = yield* registry.link({
      id: stacked.id,
      dependsOnId: base.id,
      linked: false,
    });
    assert.deepEqual([...unlinked.dependsOn], []);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("turns a planned feature real by binding it to a thread", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const planned = yield* registry.create({ name: "Intended", planned: true });
    assert.strictEqual(planned.planned, true);

    const real = yield* registry.update({ id: planned.id, threadId: ThreadId.make("thread-9") });
    assert.strictEqual(real.planned, false);
    assert.strictEqual(real.threadId, "thread-9");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("replaces the whole plan and never touches work under way", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const real = yield* registry.create({
      name: "Under way",
      threadId: ThreadId.make("thread-1"),
    });

    const first = yield* registry.planSet({
      features: [
        { key: "a", name: "Step one" },
        { key: "b", name: "Step two", dependsOn: ["a"], stage: "in-dev" },
      ],
    });
    assert.strictEqual(first.removedCount, 0);
    assert.strictEqual(first.entries.length, 2);
    assert.deepEqual([...first.entries[1]!.dependsOn], [first.entries[0]!.id]);
    assert.strictEqual(first.entries[1]!.stage, "in-dev");

    const second = yield* registry.planSet({ features: [{ key: "c", name: "Only step" }] });
    assert.strictEqual(second.removedCount, 2);

    const entries = yield* registry.list;
    assert.deepEqual([...entries].map((entry) => entry.name).toSorted(), [
      "Only step",
      "Under way",
    ]);
    // The real feature is untouched, id and all.
    assert.strictEqual(entries.find((entry) => entry.name === "Under way")!.id, real.id);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("clears the plan when handed an empty one", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    yield* registry.planSet({ features: [{ key: "a", name: "Step one" }] });
    const cleared = yield* registry.planSet({ features: [] });
    assert.strictEqual(cleared.removedCount, 1);
    assert.deepEqual([...(yield* registry.list)], []);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("drops a link to a planned feature the next plan removed", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const plan = yield* registry.planSet({ features: [{ key: "a", name: "Planned" }] });
    const real = yield* registry.create({
      name: "Real",
      threadId: ThreadId.make("thread-2"),
      dependsOn: [plan.entries[0]!.id],
    });
    assert.deepEqual([...real.dependsOn], [plan.entries[0]!.id]);

    yield* registry.planSet({ features: [] });
    const entries = yield* registry.list;
    assert.deepEqual([...entries[0]!.dependsOn], []);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("survives a reload, because the map is the file and not memory", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const created = yield* registry.create({ name: "Persisted", stage: "in-staging" });

    // A second instance over the same config path — the same thing a restart
    // produces, without needing one.
    const reopened = yield* makeFeatureMapRegistry;
    const reloaded = yield* reopened.list;

    assert.deepEqual(
      [...reloaded].map((entry) => entry.id),
      [created.id],
    );
    assert.strictEqual(reloaded[0]!.stage, "in-staging");
  }).pipe(Effect.provide(makeLayer())),
);

const atlas = ProjectCategorySlug.make("atlas");
const beacon = ProjectCategorySlug.make("beacon");

it.effect("files a feature under a project, and keeps it filed across a reload", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const created = yield* registry.create({ name: "Star map", slug: atlas });
    assert.strictEqual(created.slug, atlas);

    const reopened = yield* makeFeatureMapRegistry;
    assert.strictEqual((yield* reopened.list)[0]!.slug, atlas);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("leaves a feature unfiled when the call does not say otherwise", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    // Deliberately not derived from the bound thread's project: a stored answer
    // would be a snapshot that goes stale the moment the thread is refiled.
    const created = yield* registry.create({ name: "Star map", threadId: ThreadId.make("t-1") });
    assert.strictEqual(created.slug, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refiles a feature, and unfiles it when told null", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    const created = yield* registry.create({ name: "Star map", slug: atlas });

    const moved = yield* registry.update({ id: created.id, slug: beacon });
    assert.strictEqual(moved.slug, beacon);

    // Absence means "leave it", which is why null has to be sayable at all.
    const renamed = yield* registry.update({ id: created.id, name: "Sky map" });
    assert.strictEqual(renamed.slug, beacon);

    const unfiled = yield* registry.update({ id: created.id, slug: null });
    assert.strictEqual(unfiled.slug, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("scopes a project's plan replacement to that project", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    // One machine, two project masters. Before the slug scoped this call, the
    // second plan silently deleted the first — and neither agent could tell
    // from inside the call that caused it.
    yield* registry.planSet({ slug: atlas, features: [{ key: "a", name: "Atlas step" }] });
    const second = yield* registry.planSet({
      slug: beacon,
      features: [{ key: "b", name: "Beacon step" }],
    });

    assert.strictEqual(second.removedCount, 0);
    assert.deepEqual([...(yield* registry.list)].map((entry) => entry.name).toSorted(), [
      "Atlas step",
      "Beacon step",
    ]);
    assert.deepEqual([...(yield* registry.list)].map((entry) => entry.slug).toSorted(), [
      atlas,
      beacon,
    ]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("replaces only its own project's plan on a re-plan", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    yield* registry.planSet({ slug: atlas, features: [{ key: "a", name: "Atlas step" }] });
    yield* registry.planSet({ slug: beacon, features: [{ key: "b", name: "Beacon step" }] });

    const replanned = yield* registry.planSet({
      slug: atlas,
      features: [{ key: "c", name: "Atlas step two" }],
    });
    assert.strictEqual(replanned.removedCount, 1);
    assert.deepEqual([...(yield* registry.list)].map((entry) => entry.name).toSorted(), [
      "Atlas step two",
      "Beacon step",
    ]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("still replaces every plan when the call names no project", () =>
  Effect.gen(function* () {
    const registry = yield* FeatureMapRegistry;
    // The original contract, kept: a quietly narrowed destructive call is worse
    // than a wide one, so the fleet master's plan_set still means everything.
    yield* registry.planSet({ slug: atlas, features: [{ key: "a", name: "Atlas step" }] });
    const wide = yield* registry.planSet({ features: [{ key: "b", name: "Fleet step" }] });

    assert.strictEqual(wide.removedCount, 1);
    assert.deepEqual(
      [...(yield* registry.list)].map((entry) => entry.name),
      ["Fleet step"],
    );
    assert.strictEqual((yield* registry.list)[0]!.slug, null);
  }).pipe(Effect.provide(makeLayer())),
);
