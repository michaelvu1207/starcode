// @effect-diagnostics nodeBuiltinImport:off - builds legacy transcript fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type HistoryImportRecord,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { HistoryIndex, makeHistoryIndex } from "./HistoryIndex.ts";
import {
  LEGACY_HISTORY_READ_ONLY_DETAIL,
  legacyHistoryImportPolicy,
  makeHistoryImporter,
} from "./import.ts";
import { HistoryImportRegistry, layer as historyImportRegistryLayer } from "./importRegistry.ts";
import { historySessionIdForPath } from "./paths.ts";

const CLAUDE_SESSION_ID = "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c";
const CODEX_SESSION_ID = "019f48a7-522e-7120-a10d-285178db2830";
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

const claudeFixture = (cwd: string) =>
  `${JSON.stringify({
    type: "user",
    cwd,
    timestamp: "2026-07-23T09:00:00.000Z",
    message: { role: "user", content: "remember the codeword" },
  })}\n`;

const codexFixture = (cwd: string) =>
  `${JSON.stringify({ type: "session_meta", payload: { id: CODEX_SESSION_ID, cwd } })}\n`;

interface Harness {
  readonly workspace: string;
  readonly claudeSessionPath: string;
  readonly codexSessionPath: string;
  readonly commands: Array<OrchestrationCommand>;
  readonly bindings: Array<Partial<ProviderRuntimeBinding>>;
  readonly threads: Map<string, OrchestrationThread>;
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
    | ProviderInstanceRegistry
    | ServerSettingsService
    | WorkspacePaths.WorkspacePaths
    | ServerConfig.ServerConfig
    | NodeServices.NodeServices
  >,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-history-import-policy-")),
    );
    const workspace = NodePath.join(home, "work", "alpha");
    const claudeSessionPath = NodePath.join(
      home,
      ".claude",
      "projects",
      "-work-alpha",
      `${CLAUDE_SESSION_ID}.jsonl`,
    );
    const codexSessionPath = NodePath.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "07",
      "24",
      `rollout-2026-07-24T10-00-00-${CODEX_SESSION_ID}.jsonl`,
    );
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.dirname(claudeSessionPath), { recursive: true });
      await NodeFSP.mkdir(NodePath.dirname(codexSessionPath), { recursive: true });
      await NodeFSP.mkdir(workspace, { recursive: true });
      await NodeFSP.writeFile(claudeSessionPath, claudeFixture(workspace), "utf8");
      await NodeFSP.writeFile(codexSessionPath, codexFixture(workspace), "utf8");
    });

    const harness: Harness = {
      workspace,
      claudeSessionPath,
      codexSessionPath,
      commands: [],
      bindings: [],
      threads: new Map(),
    };
    const settings = decodeServerSettings({});
    const layer = Layer.mergeAll(
      Layer.sync(HistoryIndex, () => makeHistoryIndex({ homeDir: home, debounceMs: 0 })),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailSnapshot: (threadId: ThreadId) =>
          Effect.succeed(
            Option.fromNullishOr(harness.threads.get(threadId)).pipe(
              Option.map((thread) => ({ snapshotSequence: 1, thread })),
            ),
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
        getBinding: () => Effect.succeed(Option.none()),
      }),
      Layer.mock(ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
      }),
      Layer.mock(ServerSettingsService)({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(settings),
        updateSettings: () => Effect.succeed(settings),
        streamChanges: Stream.empty,
      }),
      WorkspacePaths.layer,
      historyImportRegistryLayer,
    ).pipe(
      Layer.provideMerge(
        Layer.fresh(ServerConfig.layerTest(home, { prefix: "starcode-history-import-policy-" })),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    return yield* use(harness).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }))),
    );
  });

describe("legacy history import policy", () => {
  it("keeps both removed native stores explicitly read-only", () => {
    assert.equal(legacyHistoryImportPolicy("claude"), "read-only");
    assert.equal(legacyHistoryImportPolicy("codex"), "read-only");
  });

  for (const provider of ["claude", "codex"] as const) {
    it.effect(`refuses a new ${provider} import before writing a thread or runtime binding`, () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const importer = yield* makeHistoryImporter;
          const path = provider === "claude" ? harness.claudeSessionPath : harness.codexSessionPath;
          const error = yield* importer
            .importSession({ sessionId: historySessionIdForPath(path) })
            .pipe(Effect.flip);

          assert.equal(error._tag, "HistoryImportRefusal");
          if (error._tag !== "HistoryImportRefusal") return;
          assert.equal(error.reason, "instance_driver_mismatch");
          assert.equal(error.detail, LEGACY_HISTORY_READ_ONLY_DETAIL);
          assert.lengthOf(harness.commands, 0);
          assert.lengthOf(harness.bindings, 0);
        }),
      ),
    );
  }

  it.effect("keeps an already-imported legacy thread navigable without launching a runtime", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const registry = yield* HistoryImportRegistry;
        const importer = yield* makeHistoryImporter;
        const threadId = ThreadId.make("thread-existing-import");
        const projectId = ProjectId.make("project-alpha");
        const historySessionId = historySessionIdForPath(harness.claudeSessionPath);
        harness.threads.set(threadId, {
          id: threadId,
          projectId,
          title: "Existing legacy import",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "openai-codex/gpt-5.6-sol",
          },
        } as unknown as OrchestrationThread);
        yield* registry.record({
          historySessionId,
          nativeSessionId: CLAUDE_SESSION_ID,
          provider: "claude",
          threadId,
          projectId,
          cwd: harness.workspace,
          importedAt: "2026-07-24T00:00:00.000Z",
          messageCount: 2,
          startedAt: "2026-07-23T09:00:00.000Z",
        } satisfies HistoryImportRecord);

        const result = yield* importer.importSession({ sessionId: historySessionId });
        assert.equal(result.status, "imported");
        if (result.status !== "imported") return;
        assert.isTrue(result.alreadyImported);
        assert.equal(result.threadId, threadId);
        assert.lengthOf(harness.commands, 0);
        assert.lengthOf(harness.bindings, 0);
      }),
    ),
  );
});
