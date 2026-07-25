/**
 * Terminal history - importing a CLI session as a starcode thread.
 *
 * What this does *not* do is copy a transcript. It creates an empty thread and
 * writes one row binding it to the session the CLI already has on disk, so the
 * thread's first turn is a `--resume` / `thread/resume` against that session
 * and the model comes back with its own context intact. Nothing is duplicated,
 * nothing is re-uploaded, and no turn is fired: the imported thread sits idle
 * until someone types into it.
 *
 * The binding row is the whole mechanism, and it is required rather than
 * optional. `ProviderService.startSession` falls back to a persisted cursor
 * only when the row's `provider_instance_id` matches the instance the thread
 * routes to, and `ProviderCommandReactor` forwards a cursor on session
 * *restart* but never on first start — so a persisted row is the only path
 * that survives a user simply typing into a freshly imported thread.
 *
 * Everything before that write is preflight, and every preflight failure is a
 * refusal rather than a fallback. The reason is asymmetric risk: a wrong
 * Claude resume id fails loudly, but Codex answers an unknown thread id by
 * starting a *fresh, empty* thread, which looks like a successful import and
 * has amnesia. So the session file must exist, it must yield an id and a
 * working directory, and it must live inside the home of the instance that
 * will resume it.
 *
 * @module HistoryImport
 */
import {
  type HistoryImportRecord,
  type HistoryImportRefusalReason,
  type HistoryImportResult,
  type HistoryProvider,
  type HistorySessionId,
  type ClientOrchestrationCommand,
  CommandId,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HistoryIndex } from "./HistoryIndex.ts";
import {
  claudeNativeSessionIdForPath,
  defaultInstanceIdForHistoryProvider,
  findProjectForCwd,
  importResumeCursor,
  importThreadTitle,
  instanceSessionStoreRoot,
  isPathWithin,
  projectTitleForCwd,
  SessionImportFold,
  type SessionImportFacts,
} from "./importFacts.ts";
import { HistoryImportRegistry } from "./importRegistry.ts";
import { foldSessionHead } from "./tailReader.ts";

/**
 * An imported thread starts in the safe mode, not the mode the terminal
 * session ran in. Nothing on disk records what permissions the CLI was given,
 * and inheriting "whatever that session had" from a guess is not a default
 * worth having — the operator can raise it in one click.
 */
const IMPORTED_THREAD_RUNTIME_MODE = "approval-required" as const;

/** The session id resolved to nothing this server has indexed. */
export class HistorySessionNotFound extends Schema.TaggedErrorClass<HistorySessionNotFound>()(
  "HistorySessionNotFound",
  {},
) {
  override get message(): string {
    return "No indexed terminal-history session with that id.";
  }
}

/** A precondition failed. Nothing was written. */
export class HistoryImportRefusal extends Schema.TaggedErrorClass<HistoryImportRefusal>()(
  "HistoryImportRefusal",
  {
    reason: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Import refused: ${this.reason}.`;
  }
}

const refuse = (reason: HistoryImportRefusalReason, detail?: string) =>
  Effect.fail(new HistoryImportRefusal({ reason, ...(detail === undefined ? {} : { detail }) }));

export interface HistoryImportInput {
  readonly sessionId: HistorySessionId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly model?: string | undefined;
  readonly title?: string | undefined;
  readonly createProject?: boolean | undefined;
}

/**
 * Reads the head of a session file for the facts an import needs.
 *
 * Failable rather than defaulting: the caller has to be able to tell "this
 * session has no working directory recorded" from "this file was deleted while
 * we were looking at it", and neither is a reason to import anyway.
 */
const readImportFacts = (input: {
  readonly path: string;
  readonly provider: HistoryProvider;
}): Effect.Effect<SessionImportFacts, HistoryImportRefusal> =>
  Effect.tryPromise({
    try: () => foldSessionHead(input, new SessionImportFold(input.provider)),
    catch: (cause) =>
      new HistoryImportRefusal({
        reason: "session_unreadable" satisfies HistoryImportRefusalReason,
        detail: `Could not read the session file: ${String(cause)}`,
      }),
  });

/**
 * The model the imported thread starts on.
 *
 * Preference order is the caller's explicit choice, then the project's own
 * default when it already points at this instance, then whatever the instance
 * advertises as its default. A thread cannot be created without one, so
 * running out of candidates is a refusal rather than a silent empty selection.
 */
const resolveModel = (input: {
  readonly requested: string | undefined;
  readonly project: OrchestrationProjectShell | null;
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}): string | null => {
  if (input.requested !== undefined && input.requested.trim().length > 0) {
    return input.requested.trim();
  }
  const projectDefault = input.project?.defaultModelSelection;
  if (projectDefault !== null && projectDefault !== undefined) {
    if (projectDefault.instanceId === input.instanceId) return projectDefault.model;
  }
  const flagged = input.models.find((model) => model.isDefault === true);
  if (flagged !== undefined) return flagged.slug;
  return input.models[0]?.slug ?? null;
};

export const makeHistoryImporter = Effect.gen(function* () {
  const historyIndex = yield* HistoryIndex;
  const registry = yield* HistoryImportRegistry;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const dispatch = (command: ClientOrchestrationCommand) =>
    normalizeDispatchCommand(command).pipe(
      Effect.flatMap((normalized) => engine.dispatch(normalized)),
    );

  const importSession = Effect.fn("history.import")(function* (input: HistoryImportInput) {
    // Idempotency first, and from the registry alone. A session that was
    // already imported should answer with its thread even if the file has
    // since moved or the instance's home has been reconfigured — re-importing
    // is a navigation action at that point, not a write.
    const recorded = Option.getOrUndefined(yield* registry.find(input.sessionId));
    if (recorded !== undefined) {
      const existingThread = yield* projectionSnapshotQuery.getThreadDetailSnapshot(
        recorded.threadId,
      );
      if (Option.isSome(existingThread)) {
        return {
          status: "imported",
          alreadyImported: true,
          threadId: recorded.threadId,
          projectId: recorded.projectId,
          cwd: recorded.cwd,
          nativeSessionId: recorded.nativeSessionId,
          provider: recorded.provider,
          providerInstanceId: existingThread.value.thread.modelSelection.instanceId,
          title: existingThread.value.thread.title,
        } satisfies HistoryImportResult;
      }
      // The thread was deleted outside this registry. Fall through and import
      // again rather than handing back an id that no longer resolves.
    }

    const entry = yield* historyIndex.resolve(input.sessionId);
    if (entry === null) return yield* new HistorySessionNotFound();

    const facts = yield* readImportFacts({ path: entry.path, provider: entry.provider });

    const nativeSessionId =
      entry.provider === "claude"
        ? claudeNativeSessionIdForPath(entry.path)
        : facts.nativeSessionId;
    if (nativeSessionId === null) {
      return yield* refuse(
        "session_id_unusable",
        entry.provider === "claude"
          ? "The session file is not named after a session id, so there is nothing to resume."
          : "The rollout has no `session_meta` record, so it carries no thread id to resume.",
      );
    }

    const cwd = facts.cwd;
    if (cwd === null) {
      return yield* refuse(
        "session_cwd_unknown",
        "The session never recorded the directory it ran in, so no project can be matched to it.",
      );
    }

    const instanceId =
      input.providerInstanceId ??
      ProviderInstanceId.make(defaultInstanceIdForHistoryProvider(entry.provider));

    // Ownership: does the instance that will resume this session actually see
    // it? Read from the same derived config map the instance registry itself
    // consumes, so the answer cannot drift from the homes the drivers use.
    const settings = yield* serverSettings.getSettings;
    const envelope = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (envelope === undefined) {
      return yield* refuse(
        "instance_not_found",
        `No provider instance '${instanceId}' is configured on this machine.`,
      );
    }
    const store = instanceSessionStoreRoot({
      driver: envelope.driver,
      config: envelope.config,
      homeDir: historyIndex.homeDir,
    });
    if (store === null || store.provider !== entry.provider) {
      return yield* refuse(
        "instance_driver_mismatch",
        `Instance '${instanceId}' runs the '${envelope.driver}' driver, which cannot resume a ${entry.provider} session.`,
      );
    }
    if (!isPathWithin(store.root, entry.path)) {
      return yield* refuse(
        "instance_home_mismatch",
        `This session is not in the store instance '${instanceId}' reads (${store.root}), so resuming through it would start an empty session instead.`,
      );
    }

    const instance = yield* instanceRegistry.getInstance(instanceId);
    if (instance === undefined) {
      return yield* refuse(
        "instance_not_found",
        `Provider instance '${instanceId}' is configured but not loaded.`,
      );
    }
    if (!instance.enabled) {
      return yield* refuse("instance_disabled", `Provider instance '${instanceId}' is disabled.`);
    }

    const shell = yield* projectionSnapshotQuery.getShellSnapshot();
    const title = importThreadTitle({ facts, provider: entry.provider, requested: input.title });

    let project: OrchestrationProjectShell | null = null;
    if (input.projectId !== undefined) {
      project = shell.projects.find((candidate) => candidate.id === input.projectId) ?? null;
      if (project === null) {
        return yield* refuse("project_not_found", `No project '${input.projectId}'.`);
      }
      if (findProjectForCwd([project], cwd) === null) {
        return yield* refuse(
          "project_cwd_mismatch",
          `Project '${project.title}' is rooted at ${project.workspaceRoot}, but the session ran in ${cwd}. A thread takes its working directory from its project, and resume needs them to match.`,
        );
      }
    } else {
      project = findProjectForCwd(shell.projects, cwd);
    }

    if (project === null && input.createProject !== true) {
      return {
        status: "needs_project",
        cwd,
        suggestedProjectTitle: projectTitleForCwd(cwd),
        provider: entry.provider,
        providerInstanceId: instanceId,
        suggestedThreadTitle: title,
      } satisfies HistoryImportResult;
    }

    const snapshot = yield* instance.snapshot.getSnapshot;
    const model = resolveModel({
      requested: input.model,
      project,
      instanceId,
      models: snapshot.models,
    });
    if (model === null) {
      return yield* refuse(
        "model_unavailable",
        `Instance '${instanceId}' advertises no models, so the imported thread has nothing to run on.`,
      );
    }
    const modelSelection = { instanceId, model } as ModelSelection;

    let projectId: ProjectId;
    if (project === null) {
      projectId = ProjectId.make(`project-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make(
          `import-project-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        projectId,
        title: projectTitleForCwd(cwd),
        workspaceRoot: cwd,
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      } as unknown as ClientOrchestrationCommand).pipe(
        Effect.catch((cause) =>
          Effect.fail(
            new HistoryImportRefusal({
              reason: "project_create_failed" satisfies HistoryImportRefusalReason,
              detail: `Could not create a project at ${cwd}: ${String(cause)}`,
            }),
          ),
        ),
      );
    } else {
      projectId = project.id;
    }

    const threadId = ThreadId.make(`thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
    // A bare `thread.create` with an explicit title and no turn. No
    // `titleSeed`, because a seed is exactly what invites the provider to
    // rename the thread on its first turn — and this thread's name is
    // provenance.
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`import-thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: IMPORTED_THREAD_RUNTIME_MODE,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    } as unknown as ClientOrchestrationCommand).pipe(
      Effect.catch((cause) =>
        Effect.fail(
          new HistoryImportRefusal({
            reason: "thread_create_failed" satisfies HistoryImportRefusalReason,
            detail: String(cause),
          }),
        ),
      ),
    );

    // The seam. `status: "stopped"` because no process has been started; the
    // row exists only to be read by the first `startSession`.
    yield* directory
      .upsert({
        threadId,
        provider: instance.driverKind,
        providerInstanceId: instanceId,
        adapterKey: instance.driverKind,
        runtimeMode: IMPORTED_THREAD_RUNTIME_MODE,
        status: "stopped",
        resumeCursor: importResumeCursor({
          provider: entry.provider,
          threadId,
          nativeSessionId,
        }),
        runtimePayload: { cwd },
      })
      .pipe(
        Effect.catch((cause) =>
          // Roll the thread back. A thread that was imported but is not bound
          // is worse than no thread at all: it looks like a resumed session
          // and answers as a blank one.
          Effect.gen(function* () {
            yield* dispatch({
              type: "thread.delete",
              commandId: CommandId.make(
                `import-rollback-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
              ),
              threadId,
            } as unknown as ClientOrchestrationCommand).pipe(Effect.ignore);
            return yield* new HistoryImportRefusal({
              reason: "binding_write_failed" satisfies HistoryImportRefusalReason,
              detail: String(cause),
            });
          }),
        ),
      );

    const record: HistoryImportRecord = {
      historySessionId: input.sessionId,
      nativeSessionId,
      provider: entry.provider,
      threadId,
      projectId,
      cwd,
      importedAt: DateTime.formatIso(yield* DateTime.now),
    };
    // Provenance is best-effort on purpose: the thread resumes off its binding
    // row whether or not this file was written, and failing an import that has
    // already succeeded because a JSON file would not save would be the wrong
    // trade.
    yield* registry.record(record).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("history import registry write failed", {
          threadId,
          historySessionId: input.sessionId,
          cause,
        }),
      ),
    );

    return {
      status: "imported",
      alreadyImported: false,
      threadId,
      projectId,
      cwd,
      nativeSessionId,
      provider: entry.provider,
      providerInstanceId: instanceId,
      title,
    } satisfies HistoryImportResult;
  });

  return { importSession };
});
