// @effect-diagnostics nodeBuiltinImport:off - builds a synthetic home directory,
// because "can this machine find the file behind the source's session id" is
// exactly the thing under test.
/**
 * Fork provenance.
 *
 * `forkFacts.test.ts` covers the cursor and the refusals. What is asserted
 * here is the row the fork leaves behind, because that row is the only thing
 * standing between a forked thread and the trap import already solved: a
 * thread that opens empty and answers as though it remembers a conversation
 * nobody can see.
 *
 * The load-bearing field is `historySessionId`. A fork knows its source's
 * *provider* session id; the reader is addressed by a hash of a file path,
 * with no reverse lookup. Bridging the two by finding the file Claude named
 * after the session is the whole reason this resolves at fork time rather
 * than at read time, and it is what these tests exercise.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
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
import { HistoryIndex, makeHistoryIndex } from "./HistoryIndex.ts";
import { makeHistoryForker } from "./fork.ts";
import { HistoryImportRegistry, layer as historyImportRegistryLayer } from "./importRegistry.ts";
import { historySessionIdForPath } from "./paths.ts";

const SOURCE_SESSION_UUID = "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c";
const SOURCE_THREAD_ID = ThreadId.make("thread-source");

const sourceSessionFixture = (cwd: string): string =>
  `${[
    JSON.stringify({
      type: "user",
      cwd,
      timestamp: "2026-07-23T09:00:00.000Z",
      message: { role: "user", content: "remember the codeword" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-23T09:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "noted" }] },
    }),
  ].join("\n")}\n`;

interface Harness {
  readonly home: string;
  readonly workspace: string;
  readonly sourceSessionPath: string;
  readonly commands: Array<OrchestrationCommand>;
  readonly bindings: Array<Partial<ProviderRuntimeBinding>>;
}

const withHarness = <A, E>(
  use: (
    harness: Harness,
  ) => Effect.Effect<
    A,
    E,
    | HistoryIndex
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
    /** False writes no session file, so the index cannot resolve the source. */
    readonly withSessionFile?: boolean;
    /** The source thread's driver. Defaults to Claude's. */
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
      ".claude",
      "projects",
      "-work-alpha",
      `${SOURCE_SESSION_UUID}.jsonl`,
    );
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(workspace, { recursive: true });
      if (options?.withSessionFile !== false) {
        await NodeFSP.mkdir(NodePath.dirname(sourceSessionPath), { recursive: true });
        await NodeFSP.writeFile(sourceSessionPath, sourceSessionFixture(workspace), "utf8");
      }
    });

    const harness: Harness = { home, workspace, sourceSessionPath, commands: [], bindings: [] };
    const sourceThread = {
      id: SOURCE_THREAD_ID,
      title: "Reworking the picker",
      projectId: ProjectId.make("project-alpha"),
      modelSelection: { instanceId: "claudeAgent", model: "sonnet" },
      runtimeMode: "local",
      interactionMode: "normal",
      branch: null,
      worktreePath: null,
    } as unknown as OrchestrationThread;

    const layer = Layer.mergeAll(
      Layer.sync(HistoryIndex, () => makeHistoryIndex({ homeDir: home, debounceMs: 0 })),
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
                  provider: options?.provider ?? "claudeAgent",
                  providerInstanceId: options?.provider ?? "claudeAgent",
                  adapterKey: options?.provider ?? "claudeAgent",
                  resumeCursor: options?.sourceCursor ?? {
                    threadId: SOURCE_THREAD_ID,
                    resume: SOURCE_SESSION_UUID,
                    turnCount: 4,
                  },
                  runtimePayload: { cwd: workspace },
                } as unknown as ProviderRuntimeBinding),
          ),
      }),
      WorkspacePaths.layer,
      historyImportRegistryLayer,
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
  it.effect("records a row the thread view can read its history from", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const forker = yield* makeHistoryForker;
        const registry = yield* HistoryImportRegistry;

        const result = yield* forker.forkThread({ threadId: SOURCE_THREAD_ID });

        const record = Option.getOrUndefined(yield* registry.findFork(result.threadId));
        assert.isDefined(record);
        assert.equal(record?.sourceThreadId, SOURCE_THREAD_ID);
        assert.equal(record?.sourceTitle, "Reworking the picker");
        assert.equal(record?.sourceSessionId, SOURCE_SESSION_UUID);
        // The bridge: the provider's session id resolved to the file this
        // machine's index knows, which is the only address the reader takes.
        assert.equal(record?.historySessionId, historySessionIdForPath(harness.sourceSessionPath));
        // The boundary, so the fork's history is what it inherited rather than
        // whatever the source thread says next.
        assert.isAbove(record?.sourceSizeBytes ?? 0, 0);
        assert.equal(record?.startedAt, "2026-07-23T09:00:00.000Z");
        assert.isDefined(record?.lastActivityAt);
      }),
    ),
  );

  it.effect("forks a Codex thread through its app-server thread id", () =>
    withHarness(
      () =>
        Effect.gen(function* () {
          const forker = yield* makeHistoryForker;

          const result = yield* forker.forkThread({ threadId: SOURCE_THREAD_ID });

          // The Codex cursor names a thread, not a session file, and the row
          // has to say "codex" rather than the hardcoded "claude" this used to
          // write — a provenance row naming the wrong provider sends the reader
          // looking in the wrong store.
          assert.equal(result.provider, "codex");
          assert.equal(result.sourceSessionId, "codex-thread-9");
        }),
      {
        provider: "codex",
        sourceCursor: { threadId: "codex-thread-9" },
        withSessionFile: false,
      },
    ),
  );

  it.effect("marks a side thread and asks its driver for an ephemeral fork", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          const forker = yield* makeHistoryForker;

          const result = yield* forker.forkThread({
            threadId: SOURCE_THREAD_ID,
            ephemeral: true,
            sideOfThreadId: SOURCE_THREAD_ID,
          });

          // Both halves, because either alone is a broken state: a thread
          // marked side but durable accumulates rollouts nobody can reach, and
          // one marked ephemeral but listed appears in the sidebar then
          // vanishes.
          const created = harness.commands.find((command) => command.type === "thread.create");
          assert.equal(
            (created as unknown as { readonly sideOfThreadId?: string })?.sideOfThreadId,
            SOURCE_THREAD_ID,
          );
          const binding = harness.bindings.find((entry) => entry.threadId === result.threadId);
          assert.equal(
            (binding?.resumeCursor as { readonly ephemeral?: boolean })?.ephemeral,
            true,
          );
        }),
      { provider: "codex", sourceCursor: { threadId: "codex-thread-9" }, withSessionFile: false },
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

  it.effect("still forks when the source's session file is not on disk", () =>
    withHarness(
      () =>
        Effect.gen(function* () {
          const forker = yield* makeHistoryForker;
          const registry = yield* HistoryImportRegistry;

          const result = yield* forker.forkThread({ threadId: SOURCE_THREAD_ID });

          // The fork resumes through the provider's own store, not through the
          // index, so a session this machine cannot locate is a fork with no
          // readable history — never a refused fork.
          const record = Option.getOrUndefined(yield* registry.findFork(result.threadId));
          assert.isNull(record?.historySessionId ?? null);
          assert.isUndefined(record?.sourceSizeBytes);
          assert.equal(record?.sourceSessionId, SOURCE_SESSION_UUID);
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
