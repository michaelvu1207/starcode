import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HistorySessionId,
  ProjectId,
  ThreadId,
  type HistoryImportRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { HistoryImportRegistry, layer as historyImportRegistryLayer } from "./importRegistry.ts";

const makeLayer = () =>
  historyImportRegistryLayer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-history-imports-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const record = (overrides?: Partial<HistoryImportRecord>): HistoryImportRecord => ({
  historySessionId: HistorySessionId.make("a".repeat(32)),
  nativeSessionId: "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c",
  provider: "claude",
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  cwd: "/tmp/alpha",
  importedAt: "2026-07-24T00:00:00.000Z",
  messageCount: 12,
  startedAt: "2026-07-23T09:00:00.000Z",
  ...overrides,
});

it.effect("reports nothing, and writes nothing, before the first import", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    assert.deepEqual([...(yield* registry.list)], []);
    assert.isTrue(Option.isNone(yield* registry.find(HistorySessionId.make("b".repeat(32)))));
    // A machine that has never imported has no file at all — the registry is
    // not a schema, it is a side effect of importing.
    assert.isFalse(yield* fileSystem.exists(config.historyImportsPath));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("round-trips a record through the file", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const entry = record();

    yield* registry.record(entry);

    assert.deepEqual([...(yield* registry.list)], [entry]);
    assert.deepEqual(Option.getOrUndefined(yield* registry.find(entry.historySessionId)), entry);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps one row per session, replacing the earlier import", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const first = record();
    // Same session, re-imported after its first thread was deleted.
    const second = record({ threadId: ThreadId.make("thread-2") });
    const other = record({
      historySessionId: HistorySessionId.make("c".repeat(32)),
      threadId: ThreadId.make("thread-3"),
    });

    yield* registry.record(first);
    yield* registry.record(other);
    yield* registry.record(second);

    const imports = yield* registry.list;
    assert.lengthOf(imports, 2);
    assert.deepEqual(
      Option.getOrUndefined(yield* registry.find(first.historySessionId))?.threadId,
      ThreadId.make("thread-2"),
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("survives concurrent writes without dropping a row", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const entries = Array.from({ length: 8 }, (_unused, index) =>
      record({
        historySessionId: HistorySessionId.make(String(index).repeat(32)),
        threadId: ThreadId.make(`thread-${index}`),
      }),
    );

    yield* Effect.forEach(entries, (entry) => registry.record(entry), {
      concurrency: "unbounded",
      discard: true,
    });

    assert.lengthOf(yield* registry.list, entries.length);
  }).pipe(Effect.provide(makeLayer())),
);
