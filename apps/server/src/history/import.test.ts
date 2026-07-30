// @effect-diagnostics nodeBuiltinImport:off - builds a synthetic home directory
// and a synthetic workspace, because "does this session belong to this
// instance's home" is exactly the thing under test.
/**
 * Import, end to end minus the provider.
 *
 * These tests stop one step short of running a CLI: they assert the *binding*
 * an import writes, because that row is the entire mechanism. A test that only
 * checked "a thread was created" would pass for an import that produces a
 * thread with amnesia, which is the failure this feature has to prevent. The
 * real resume — a Claude session told a codeword outside t3, imported, and
 * asked for it back — is a manual proof; what is automated here is every
 * precondition that has to hold before that resume is even attempted.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  type ThreadId,
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
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { HistoryIndex, makeHistoryIndex } from "./HistoryIndex.ts";
import { makeHistoryImporter } from "./import.ts";
import { HistoryImportRegistry, layer as historyImportRegistryLayer } from "./importRegistry.ts";
import { historySessionIdForPath } from "./paths.ts";

const CLAUDE_SESSION_UUID = "9f2b6c1a-4d3e-4f5a-8b7c-0d1e2f3a4b5c";
const CODEX_ROLLOUT_UUID = "019f48a7-522e-7120-a10d-285178db2830";
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

interface Harness {
  readonly home: string;
  readonly workspace: string;
  readonly claudeSessionPath: string;
  readonly codexSessionPath: string;
  readonly commands: Array<OrchestrationCommand>;
  readonly bindings: Array<Partial<ProviderRuntimeBinding>>;
  readonly projects: Array<OrchestrationProjectShell>;
  readonly threads: Map<string, OrchestrationThread>;
}

/**
 * Fixture bodies live at module scope so their `JSON.stringify` calls stay out
 * of an Effect context, matching `HistoryIndex.test.ts`.
 */
const claudeSessionFixture = (cwd: string): string =>
  `${[
    JSON.stringify({ type: "ai-title", aiTitle: "stale first guess" }),
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
    JSON.stringify({ type: "ai-title", aiTitle: "Codeword session" }),
  ].join("\n")}\n`;

const codexRolloutFixture = (cwd: string): string =>
  `${[
    JSON.stringify({ type: "session_meta", payload: { id: CODEX_ROLLOUT_UUID, cwd } }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "ship the thing" },
    }),
  ].join("\n")}\n`;

const writeFile = (path: string, contents: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents, "utf8");
  });

const makeInstance = (input: {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly enabled?: boolean;
  readonly models?: ReadonlyArray<{ slug: string; isDefault?: boolean }>;
}): ProviderInstance =>
  ({
    instanceId: ProviderInstanceId.make(input.instanceId),
    driverKind: input.driverKind,
    continuationIdentity: { driverKind: input.driverKind, continuationKey: "test" },
    displayName: undefined,
    enabled: input.enabled ?? true,
    snapshot: {
      getSnapshot: Effect.succeed({
        models: input.models ?? [{ slug: "sonnet", isDefault: true }],
      }),
    },
    adapter: undefined,
    textGeneration: undefined,
  }) as unknown as ProviderInstance;

/**
 * A machine with two CLI sessions on disk, one configured project, and two
 * provider instances rooted at the default homes.
 *
 * `settings` and `instances` are the two knobs the refusal tests turn: point an
 * instance's `homePath` somewhere else and the same session stops being
 * importable through it.
 */
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
  options?: {
    readonly settings?: Record<string, unknown>;
    readonly instances?: ReadonlyArray<ProviderInstance>;
    readonly withProject?: boolean;
  },
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-history-import-")),
    );
    const workspace = NodePath.join(home, "work", "alpha");
    yield* Effect.promise(() => NodeFSP.mkdir(workspace, { recursive: true }));

    const claudeSessionPath = NodePath.join(
      home,
      ".claude",
      "projects",
      "-work-alpha",
      `${CLAUDE_SESSION_UUID}.jsonl`,
    );
    const codexSessionPath = NodePath.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "07",
      "24",
      `rollout-2026-07-24T10-00-00-${CODEX_ROLLOUT_UUID}.jsonl`,
    );

    yield* writeFile(claudeSessionPath, claudeSessionFixture(workspace));
    yield* writeFile(codexSessionPath, codexRolloutFixture(workspace));

    const harness: Harness = {
      home,
      workspace,
      claudeSessionPath,
      codexSessionPath,
      commands: [],
      bindings: [],
      projects:
        options?.withProject === false
          ? []
          : [
              {
                id: ProjectId.make("project-alpha"),
                title: "alpha",
                workspaceRoot: workspace,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-07-24T00:00:00.000Z",
                updatedAt: "2026-07-24T00:00:00.000Z",
              } as unknown as OrchestrationProjectShell,
            ],
      threads: new Map(),
    };

    const instances =
      options?.instances ??
      ([
        makeInstance({ instanceId: "claudeAgent", driverKind: "claudeAgent" }),
        makeInstance({
          instanceId: "codex",
          driverKind: "codex",
          models: [{ slug: "gpt-5-codex", isDefault: true }],
        }),
      ] as ReadonlyArray<ProviderInstance>);

    const settings = decodeServerSettings(options?.settings ?? {});

    const layer = Layer.mergeAll(
      Layer.sync(HistoryIndex, () => makeHistoryIndex({ homeDir: home, debounceMs: 0 })),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: harness.projects,
            threads: [],
            updatedAt: "2026-07-24T00:00:00.000Z",
          }),
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
            // Stand in for the projector: a created thread becomes readable,
            // which is what the idempotency check consults.
            if (command.type === "thread.create") {
              harness.threads.set(command.threadId, {
                id: command.threadId,
                title: command.title,
                modelSelection: command.modelSelection,
              } as unknown as OrchestrationThread);
            }
            if (command.type === "thread.delete") {
              harness.threads.delete(command.threadId);
            }
            if (command.type === "project.create") {
              harness.projects.push({
                id: command.projectId,
                title: command.title,
                workspaceRoot: command.workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-07-24T00:00:00.000Z",
                updatedAt: "2026-07-24T00:00:00.000Z",
              } as unknown as OrchestrationProjectShell);
            }
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
        getInstance: (instanceId: ProviderInstanceId) =>
          Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
        listInstances: Effect.succeed(instances),
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
        Layer.fresh(ServerConfig.layerTest(home, { prefix: "starcode-history-import-test-" })),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    return yield* use(harness).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }))),
    );
  });

const sessionId = (path: string) => historySessionIdForPath(path);

const threadCreates = (harness: Harness) =>
  harness.commands.filter((command) => command.type === "thread.create");

describe("history import", () => {
  it.effect("binds an imported Claude thread to the session it came from", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const result = yield* importer.importSession({
          sessionId: sessionId(harness.claudeSessionPath),
        });

        assert.equal(result.status, "imported");
        if (result.status !== "imported") return;
        assert.isFalse(result.alreadyImported);
        assert.equal(result.nativeSessionId, CLAUDE_SESSION_UUID);
        assert.equal(result.cwd, harness.workspace);
        assert.equal(result.projectId, "project-alpha");
        // The *last* ai-title wins, over both the stale earlier one and the
        // first user message.
        assert.equal(result.title, "Codeword session");
        // Provenance for the client's one-line "resumed from…" marker.
        assert.equal(result.messageCount, 2);
        assert.equal(result.startedAt, "2026-07-23T09:00:00.000Z");

        // One thread, no turn: an imported thread sits idle until someone types.
        assert.lengthOf(threadCreates(harness), 1);
        assert.isFalse(
          harness.commands.some((command) => command.type === "thread.turn.start"),
          "import must not fire a paid turn",
        );

        const binding = harness.bindings[0];
        assert.deepEqual(binding?.resumeCursor, {
          threadId: result.threadId,
          resume: CLAUDE_SESSION_UUID,
          turnCount: 0,
        });
        assert.deepEqual(binding?.runtimePayload, { cwd: harness.workspace });
        // The instance id has to match the one the thread routes to, or
        // `ProviderService.startSession` drops the cursor on the floor.
        assert.equal(binding?.providerInstanceId, "claudeAgent");
        assert.equal(binding?.status, "stopped");
      }),
    ),
  );

  // The two runtime-mode tests spell the modes as literals rather than as
  // `DEFAULT_RUNTIME_MODE`. What is under test is the policy — an imported
  // thread is as capable as one started in the composer, and a caller who
  // names a mode gets it — and an assertion written against the constant
  // would follow the constant and prove neither.
  it.effect("starts an imported thread in the app-wide default runtime mode", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const result = yield* importer.importSession({
          sessionId: sessionId(harness.claudeSessionPath),
        });

        assert.equal(result.status, "imported");
        const created = threadCreates(harness)[0];
        assert.equal(created?.type === "thread.create" ? created.runtimeMode : null, "full-access");
        // The binding has to agree with the thread, or the thread reads one
        // way in the composer and the resumed session runs the other.
        assert.equal(harness.bindings[0]?.runtimeMode, "full-access");
      }),
    ),
  );

  it.effect("records the runtime mode the caller asked for", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const result = yield* importer.importSession({
          sessionId: sessionId(harness.claudeSessionPath),
          runtimeMode: "approval-required",
        });

        assert.equal(result.status, "imported");
        const created = threadCreates(harness)[0];
        assert.equal(
          created?.type === "thread.create" ? created.runtimeMode : null,
          "approval-required",
        );
        assert.equal(harness.bindings[0]?.runtimeMode, "approval-required");
      }),
    ),
  );

  it.effect("binds an imported Codex thread with the rollout id as its cursor", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const result = yield* importer.importSession({
          sessionId: sessionId(harness.codexSessionPath),
        });

        assert.equal(result.status, "imported");
        if (result.status !== "imported") return;
        assert.equal(result.nativeSessionId, CODEX_ROLLOUT_UUID);
        assert.equal(result.providerInstanceId, "codex");
        assert.equal(result.title, "ship the thing");
        assert.deepEqual(harness.bindings[0]?.resumeCursor, { threadId: CODEX_ROLLOUT_UUID });
      }),
    ),
  );

  it.effect("answers a re-import with the thread the first import made", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const id = sessionId(harness.claudeSessionPath);
        const first = yield* importer.importSession({ sessionId: id });
        const second = yield* importer.importSession({ sessionId: id });

        assert.equal(first.status, "imported");
        assert.equal(second.status, "imported");
        if (first.status !== "imported" || second.status !== "imported") return;
        assert.isTrue(second.alreadyImported);
        assert.equal(second.threadId, first.threadId);
        // Nothing was written the second time.
        assert.lengthOf(threadCreates(harness), 1);
        assert.lengthOf(harness.bindings, 1);
      }),
    ),
  );

  it.effect("imports again when the recorded thread has been deleted", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const id = sessionId(harness.claudeSessionPath);
        const first = yield* importer.importSession({ sessionId: id });
        assert.equal(first.status, "imported");
        if (first.status !== "imported") return;

        // The operator deleted the thread outside the registry. A stale row
        // must not hand back an id that no longer resolves.
        harness.threads.delete(first.threadId);

        const second = yield* importer.importSession({ sessionId: id });
        assert.equal(second.status, "imported");
        if (second.status !== "imported") return;
        assert.isFalse(second.alreadyImported);
        assert.notEqual(second.threadId, first.threadId);
        assert.lengthOf(threadCreates(harness), 2);
      }),
    ),
  );

  it.effect("records provenance the imports route can read back", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const registry = yield* HistoryImportRegistry;
        const id = sessionId(harness.claudeSessionPath);
        const result = yield* importer.importSession({ sessionId: id });
        assert.equal(result.status, "imported");
        if (result.status !== "imported") return;

        const imports = yield* registry.list;
        assert.lengthOf(imports, 1);
        assert.equal(imports[0]?.historySessionId, id);
        assert.equal(imports[0]?.nativeSessionId, CLAUDE_SESSION_UUID);
        assert.equal(imports[0]?.threadId, result.threadId);
        assert.equal(imports[0]?.cwd, harness.workspace);
      }),
    ),
  );

  it.effect("refuses a session id the index does not know", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const error = yield* importer
          .importSession({ sessionId: "0".repeat(32) as never })
          .pipe(Effect.flip);

        assert.equal(error._tag, "HistorySessionNotFound");
      }),
    ),
  );

  it.effect("refuses a session that is not in the chosen instance's home", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          const importer = yield* makeHistoryImporter;
          const error = yield* importer
            .importSession({ sessionId: sessionId(harness.claudeSessionPath) })
            .pipe(Effect.flip);

          assert.equal(error._tag, "HistoryImportRefusal");
          if (error._tag !== "HistoryImportRefusal") return;
          assert.equal(error.reason, "instance_home_mismatch");
          // Nothing was written: this refusal is the one standing between an
          // import and a thread that silently resumes nothing.
          assert.lengthOf(harness.commands, 0);
          assert.lengthOf(harness.bindings, 0);
        }),
      {
        // The instance reads a different account's home, so the session it was
        // asked to resume is invisible to it.
        settings: { providers: { claudeAgent: { homePath: "/nonexistent/claude-homes/work" } } },
      },
    ),
  );

  it.effect("refuses a Claude session pointed at a Codex instance", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const error = yield* importer
          .importSession({
            sessionId: sessionId(harness.claudeSessionPath),
            providerInstanceId: ProviderInstanceId.make("codex"),
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "HistoryImportRefusal");
        if (error._tag !== "HistoryImportRefusal") return;
        assert.equal(error.reason, "instance_driver_mismatch");
      }),
    ),
  );

  it.effect("refuses an instance that is not configured", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        const error = yield* importer
          .importSession({
            sessionId: sessionId(harness.claudeSessionPath),
            providerInstanceId: ProviderInstanceId.make("claude_work"),
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "HistoryImportRefusal");
        if (error._tag !== "HistoryImportRefusal") return;
        assert.equal(error.reason, "instance_not_found");
      }),
    ),
  );

  it.effect("refuses a disabled instance", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          const importer = yield* makeHistoryImporter;
          const error = yield* importer
            .importSession({ sessionId: sessionId(harness.claudeSessionPath) })
            .pipe(Effect.flip);

          assert.equal(error._tag, "HistoryImportRefusal");
          if (error._tag !== "HistoryImportRefusal") return;
          assert.equal(error.reason, "instance_disabled");
        }),
      {
        instances: [
          makeInstance({ instanceId: "claudeAgent", driverKind: "claudeAgent", enabled: false }),
        ],
      },
    ),
  );

  it.effect("refuses a project rooted somewhere other than the session's cwd", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        harness.projects.push({
          id: ProjectId.make("project-elsewhere"),
          title: "elsewhere",
          workspaceRoot: NodePath.join(harness.home, "work"),
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        } as unknown as OrchestrationProjectShell);

        const error = yield* importer
          .importSession({
            sessionId: sessionId(harness.claudeSessionPath),
            projectId: ProjectId.make("project-elsewhere"),
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "HistoryImportRefusal");
        if (error._tag !== "HistoryImportRefusal") return;
        assert.equal(error.reason, "project_cwd_mismatch");
      }),
    ),
  );

  it.effect("asks before creating a project, then creates one when told to", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          const importer = yield* makeHistoryImporter;
          const id = sessionId(harness.claudeSessionPath);

          const asked = yield* importer.importSession({ sessionId: id });
          assert.equal(asked.status, "needs_project");
          if (asked.status !== "needs_project") return;
          assert.equal(asked.cwd, harness.workspace);
          assert.equal(asked.suggestedProjectTitle, "alpha");
          assert.equal(asked.suggestedThreadTitle, "Codeword session");
          // Asking writes nothing.
          assert.lengthOf(harness.commands, 0);

          const imported = yield* importer.importSession({ sessionId: id, createProject: true });
          assert.equal(imported.status, "imported");
          if (imported.status !== "imported") return;

          const created = harness.commands.filter((command) => command.type === "project.create");
          assert.lengthOf(created, 1);
          assert.equal(created[0]?.workspaceRoot, harness.workspace);
          assert.equal(imported.projectId, created[0]?.projectId);
        }),
      { withProject: false },
    ),
  );

  it.effect("refuses when the instance advertises no model to run on", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          const importer = yield* makeHistoryImporter;
          const error = yield* importer
            .importSession({ sessionId: sessionId(harness.claudeSessionPath) })
            .pipe(Effect.flip);

          assert.equal(error._tag, "HistoryImportRefusal");
          if (error._tag !== "HistoryImportRefusal") return;
          assert.equal(error.reason, "model_unavailable");
        }),
      {
        instances: [
          makeInstance({ instanceId: "claudeAgent", driverKind: "claudeAgent", models: [] }),
        ],
      },
    ),
  );

  it.effect("takes the caller's model over the instance default", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const importer = yield* makeHistoryImporter;
        yield* importer.importSession({
          sessionId: sessionId(harness.claudeSessionPath),
          model: "opus",
        });

        const created = threadCreates(harness)[0];
        assert.equal(created?.modelSelection.model, "opus");
        assert.equal(created?.modelSelection.instanceId, "claudeAgent");
      }),
    ),
  );
});
