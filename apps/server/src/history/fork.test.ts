// @effect-diagnostics nodeBuiltinImport:off - builds a synthetic Pi transcript.
/**
 * Fork provenance.
 *
 * `forkFacts.test.ts` covers the cursor and the refusals. What is asserted
 * here is the row the fork leaves behind, because that row is the only thing
 * standing between a forked thread and the trap import already solved: a
 * thread that opens empty and answers as though it remembers a conversation
 * nobody can see.
 *
 * Pi's transcript is copied by the adapter and is intentionally not presented
 * as a legacy Claude/Codex history session. The load-bearing proof here is the
 * strict Pi fork cursor plus provenance that says Pi.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type HistoryForkRecord,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeHistoryForker } from "./fork.ts";
import { HistoryImportRegistry } from "./importRegistry.ts";

const SOURCE_SESSION_ID = "pi-session-source";
const SOURCE_THREAD_ID = ThreadId.make("thread-source");

const sourceSessionFixture = (cwd: string): string =>
  `${[
    JSON.stringify({
      type: "session",
      version: 3,
      id: SOURCE_SESSION_ID,
      cwd,
      timestamp: "2026-07-23T09:00:00.000Z",
    }),
  ].join("\n")}\n`;

interface Harness {
  readonly home: string;
  readonly workspace: string;
  readonly sourceSessionPath: string;
  readonly commands: Array<OrchestrationCommand>;
  readonly bindings: Array<Partial<ProviderRuntimeBinding>>;
  readonly forkRecords: Array<HistoryForkRecord>;
}

const withHarness = <A, E>(
  use: (
    harness: Harness,
  ) => Effect.Effect<
    A,
    E,
    | HistoryImportRegistry
    | ProjectionSnapshotQuery
    | OrchestrationEngineService
    | ProviderSessionDirectory
    | WorkspacePaths.WorkspacePaths
    | ServerConfig.ServerConfig
    | NodeServices.NodeServices
  >,
  options?: {
    /** Absent means the source thread has never started a session. */
    readonly sourceCursor?: Record<string, unknown> | undefined;
    /** False removes the transcript Pi would need to copy. */
    readonly withSessionFile?: boolean;
    /** The source thread's driver. Defaults to Pi. */
    readonly provider?: string;
  },
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-history-fork-")),
    );
    const workspace = NodePath.join(home, "work", "alpha");
    const sourceSessionPath = NodePath.join(
      home,
      ".starcode",
      "pi",
      "sessions",
      `${SOURCE_SESSION_ID}.jsonl`,
    );
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(workspace, { recursive: true });
      if (options?.withSessionFile !== false) {
        await NodeFSP.mkdir(NodePath.dirname(sourceSessionPath), { recursive: true });
        await NodeFSP.writeFile(sourceSessionPath, sourceSessionFixture(workspace), "utf8");
      }
    });

    const harness: Harness = {
      home,
      workspace,
      sourceSessionPath,
      commands: [],
      bindings: [],
      forkRecords: [],
    };
    const sourceThread = {
      id: SOURCE_THREAD_ID,
      title: "Reworking the picker",
      projectId: ProjectId.make("project-alpha"),
      modelSelection: { instanceId: "pi", model: "openai-codex/gpt-5.6-sol" },
      runtimeMode: "local",
      interactionMode: "normal",
      branch: null,
      worktreePath: null,
    } as unknown as OrchestrationThread;

    const layer = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailSnapshot: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === SOURCE_THREAD_ID
              ? Option.some({ snapshotSequence: 1, thread: sourceThread })
              : Option.none(),
          ),
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.commands.push(command);
            return { sequence: harness.commands.length };
          }),
      }),
      Layer.mock(ProviderSessionDirectory)({
        upsert: (binding: Partial<ProviderRuntimeBinding>) =>
          Effect.sync(() => {
            harness.bindings.push(binding);
          }),
        getBinding: () =>
          Effect.succeed(
            options !== undefined && "sourceCursor" in options && options.sourceCursor === undefined
              ? Option.none()
              : Option.some({
                  threadId: SOURCE_THREAD_ID,
                  provider: options?.provider ?? "pi",
                  providerInstanceId: options?.provider ?? "pi",
                  adapterKey: options?.provider ?? "pi",
                  resumeCursor: options?.sourceCursor ?? {
                    sessionFile: sourceSessionPath,
                    sessionId: SOURCE_SESSION_ID,
                    context: "600k",
                  },
                  runtimePayload: { cwd: workspace },
                } as unknown as ProviderRuntimeBinding),
          ),
      }),
      WorkspacePaths.layer,
      Layer.mock(HistoryImportRegistry)({
        list: Effect.succeed([]),
        find: () => Effect.succeed(Option.none()),
        record: () => Effect.void,
        listForks: Effect.sync(() => harness.forkRecords),
        findFork: (threadId: ThreadId) =>
          Effect.sync(() =>
            Option.fromNullishOr(
              harness.forkRecords.find((record) => record.threadId === threadId),
            ),
          ),
        recordFork: (record: HistoryForkRecord) =>
          Effect.sync(() => {
            harness.forkRecords.push(record);
          }),
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.fresh(ServerConfig.layerTest(home, { prefix: "starcode-history-fork-test-" })),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    return yield* use(harness).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }))),
    );
  });

describe("history fork provenance", () => {
  it.effect("records Pi provenance and a strict transcript-copy cursor", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const forker = yield* makeHistoryForker;
        const registry = yield* HistoryImportRegistry;

        const result = yield* forker.forkThread({ threadId: SOURCE_THREAD_ID });

        const record = Option.getOrUndefined(yield* registry.findFork(result.threadId));
        assert.isDefined(record);
        assert.equal(record?.sourceThreadId, SOURCE_THREAD_ID);
        assert.equal(record?.sourceTitle, "Reworking the picker");
        assert.equal(record?.sourceSessionId, SOURCE_SESSION_ID);
        assert.equal(record?.provider, "pi");
        assert.isNull(record?.historySessionId ?? null);

        const binding = harness.bindings.find((entry) => entry.threadId === result.threadId);
        assert.deepEqual(binding?.resumeCursor, {
          sessionFile: harness.sourceSessionPath,
          sessionId: SOURCE_SESSION_ID,
          fork: true,
        });
      }),
    ),
  );

  it.effect("refuses a retired Codex binding without writing anything", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          const forker = yield* makeHistoryForker;
          const refusal = yield* forker
            .forkThread({ threadId: SOURCE_THREAD_ID })
            .pipe(Effect.flip);
          assert.equal(refusal.reason, "provider_unsupported");
          assert.lengthOf(harness.commands, 0);
          assert.lengthOf(harness.bindings, 0);
        }),
      {
        provider: "codex",
        sourceCursor: { threadId: "codex-thread-9" },
      },
    ),
  );

  it.effect("marks a side thread without inventing unsupported Pi ephemerality", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const forker = yield* makeHistoryForker;

        const result = yield* forker.forkThread({
          threadId: SOURCE_THREAD_ID,
          ephemeral: true,
          sideOfThreadId: SOURCE_THREAD_ID,
        });

        const created = harness.commands.find((command) => command.type === "thread.create");
        assert.equal(
          (created as unknown as { readonly sideOfThreadId?: string })?.sideOfThreadId,
          SOURCE_THREAD_ID,
        );
        const binding = harness.bindings.find((entry) => entry.threadId === result.threadId);
        assert.isUndefined((binding?.resumeCursor as { readonly ephemeral?: boolean })?.ephemeral);
      }),
    ),
  );

  it.effect("leaves an ordinary fork listable and durable", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const forker = yield* makeHistoryForker;

        const result = yield* forker.forkThread({ threadId: SOURCE_THREAD_ID });

        // The regression guard for the sidebar's existing "Fork with
        // conversation": it must keep producing a thread you can find.
        const created = harness.commands.find((command) => command.type === "thread.create");
        assert.isUndefined(
          (created as unknown as { readonly sideOfThreadId?: string })?.sideOfThreadId,
        );
        const binding = harness.bindings.find((entry) => entry.threadId === result.threadId);
        assert.isUndefined((binding?.resumeCursor as { readonly ephemeral?: boolean })?.ephemeral);
      }),
    ),
  );

  it.effect("keeps the fork itself out of the import registry", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const forker = yield* makeHistoryForker;
        const registry = yield* HistoryImportRegistry;

        yield* forker.forkThread({ threadId: SOURCE_THREAD_ID });

        // The import array maps a *history session* to the thread that claimed
        // it, one row per session. A fork claims no session — the source still
        // owns it — so writing one here would badge that session as imported
        // and offer to open the fork instead of importing it.
        assert.deepEqual([...(yield* registry.list)], []);
      }),
    ),
  );

  it.effect("refuses when the source Pi transcript is not on disk", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          const forker = yield* makeHistoryForker;
          const registry = yield* HistoryImportRegistry;

          const refusal = yield* forker
            .forkThread({ threadId: SOURCE_THREAD_ID })
            .pipe(Effect.flip);
          assert.equal(refusal.reason, "no_resumable_session");
          assert.lengthOf(harness.commands, 0);
          assert.lengthOf(harness.bindings, 0);
          assert.deepEqual([...(yield* registry.listForks)], []);
        }),
      { withSessionFile: false },
    ),
  );

  it.effect("writes no provenance for a fork that was refused", () =>
    withHarness(
      () =>
        Effect.gen(function* () {
          const forker = yield* makeHistoryForker;
          const registry = yield* HistoryImportRegistry;

          const outcome = yield* forker
            .forkThread({ threadId: SOURCE_THREAD_ID })
            .pipe(Effect.flip);

          assert.equal(outcome.reason, "no_resumable_session");
          assert.deepEqual([...(yield* registry.listForks)], []);
        }),
      { sourceCursor: undefined },
    ),
  );
});
