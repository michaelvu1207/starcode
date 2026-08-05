import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HistorySessionId,
  ProjectId,
  ThreadId,
  type HistoryForkRecord,
  type HistoryImportRecord,
} from "@starcode/contracts";
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
        ServerConfig.layerTest(process.cwd(), { prefix: "starcode-history-imports-test-" }),
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

/**
 * The file a server from before forks existed wrote.
 *
 * At module scope so the encoding stays out of an Effect context, matching the
 * fixture convention in `preview.test.ts` and `HistoryIndex.test.ts`.
 */
const legacyRegistryContents = (entry: HistoryImportRecord): string =>
  JSON.stringify({ version: 1, imports: [entry] });

/** A file carrying the key but nothing in it — hand-edited, or a fork undone. */
const emptyForksRegistryContents = (entry: HistoryImportRecord): string =>
  JSON.stringify({ version: 1, imports: [entry], forks: [] });

const forkRecord = (overrides?: Partial<HistoryForkRecord>): HistoryForkRecord => ({
  threadId: ThreadId.make("thread-fork-1"),
  sourceThreadId: ThreadId.make("thread-1"),
  sourceTitle: "Reworking the picker",
  sourceSessionId: "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c",
  provider: "pi",
  projectId: ProjectId.make("project-1"),
  forkedAt: "2026-07-26T00:00:00.000Z",
  historySessionId: HistorySessionId.make("d".repeat(32)),
  sourceSizeBytes: 4096,
  startedAt: "2026-07-23T09:00:00.000Z",
  lastActivityAt: "2026-07-25T18:00:00.000Z",
  ...overrides,
});

it.effect("round-trips a fork alongside the imports", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const imported = record();
    const forked = forkRecord();

    yield* registry.record(imported);
    yield* registry.recordFork(forked);

    // Both arrays survive the other's write: a thread asking where its
    // conversation came from reads one file and gets both answers.
    assert.deepEqual([...(yield* registry.list)], [imported]);
    assert.deepEqual([...(yield* registry.listForks)], [forked]);
    assert.deepEqual(Option.getOrUndefined(yield* registry.findFork(forked.threadId)), forked);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps one row per fork, not per source thread", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    // One conversation forked twice, to try two directions from the same
    // point. Both forks need their own provenance line.
    const first = forkRecord();
    const second = forkRecord({ threadId: ThreadId.make("thread-fork-2") });

    yield* registry.recordFork(first);
    yield* registry.recordFork(second);

    assert.lengthOf(yield* registry.listForks, 2);
    assert.deepEqual(
      Option.getOrUndefined(yield* registry.findFork(second.threadId))?.sourceThreadId,
      first.sourceThreadId,
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("reads a registry file written before forks existed", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const imported = record();

    // Exactly the file a pre-F12.2 server wrote: no `forks` key at all. It
    // must read as "no forks", not as a decode failure that costs the machine
    // its import badges too.
    yield* fileSystem.writeFileString(config.historyImportsPath, legacyRegistryContents(imported));

    assert.deepEqual([...(yield* registry.list)], [imported]);
    assert.deepEqual([...(yield* registry.listForks)], []);

    // And writing a fork into it does not cost the import its row.
    yield* registry.recordFork(forkRecord());
    assert.deepEqual([...(yield* registry.list)], [imported]);
    assert.lengthOf(yield* registry.listForks, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("leaves the file shaped as it was on a machine that has never forked", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    yield* registry.record(record());

    // An older server reading this file decodes `forks: []` fine, but writing
    // a key nobody asked for is how a format drifts. Absent stays absent.
    const contents = yield* fileSystem.readFileString(config.historyImportsPath);
    assert.isFalse(contents.includes("forks"));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("normalises an empty forks array back out of the file", () =>
  Effect.gen(function* () {
    const registry = yield* HistoryImportRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const imported = record();

    yield* fileSystem.writeFileString(
      config.historyImportsPath,
      emptyForksRegistryContents(imported),
    );
    // Any write rewrites the whole file, so this is the moment the key would
    // become permanent. A machine that has never forked should keep producing
    // exactly the file it produced before forks existed — an empty array left
    // lying in it is how a format drifts one release at a time.
    yield* registry.record(record({ threadId: ThreadId.make("thread-2") }));

    const contents = yield* fileSystem.readFileString(config.historyImportsPath);
    assert.isFalse(contents.includes("forks"));
    assert.deepEqual([...(yield* registry.listForks)], []);
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
