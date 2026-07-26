/**
 * Forking a thread's conversation into a new thread.
 *
 * The mirror of `import.ts`, and built out of the same three moves: create an
 * empty thread, write one binding row, fire no turn. Import points that row at
 * a session a CLI left on disk; fork points it at the session a thread here is
 * already using. Nothing is copied, no transcript is read, and the fork sits
 * idle until someone types into it.
 *
 * What makes this safe rather than merely convenient is one field on the
 * cursor. Two threads carrying the same provider session id and both taking a
 * turn is not a conflict anybody detects — the adapter's session map is keyed
 * by `ThreadId`, so each thread gets its own process, and both then append to
 * one transcript file. The fork marker (`forkFacts.forkResumeCursor`) is what
 * turns the first turn into `forkSession: true`, which resumes the source's
 * history and writes to a **new** session id. The source is read and never
 * written.
 *
 * Every precondition is a refusal, never a fallback, for the reason import
 * documents: a fork that quietly degraded to an empty thread would look
 * identical to one that worked and would only be caught by asking the model
 * something it should have remembered.
 *
 * Two things this deliberately does not do. It does not touch the import
 * registry — that file maps a *history session* to the thread that imported it,
 * one row per session, and a fork is neither. And it does not copy the source's
 * settled/snoozed state: a fork is new work, and new work is active.
 *
 * @module HistoryFork
 */
import {
  type ClientOrchestrationCommand,
  CommandId,
  type HistoryForkRefusalReason,
  type HistoryForkResult,
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
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  forkResumeCursor,
  forkThreadTitle,
  isForkableDriverKind,
  readBindingCwd,
  readForkableSessionId,
} from "./forkFacts.ts";

/** A precondition failed. Nothing was written. */
export class HistoryForkRefusal extends Schema.TaggedErrorClass<HistoryForkRefusal>()(
  "HistoryForkRefusal",
  {
    reason: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Fork refused: ${this.reason}.`;
  }
}

const refuse = (reason: HistoryForkRefusalReason, detail?: string) =>
  Effect.fail(new HistoryForkRefusal({ reason, ...(detail === undefined ? {} : { detail }) }));

export interface HistoryForkInput {
  readonly threadId: ThreadId;
  readonly title?: string | undefined;
}

export const makeHistoryForker = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;

  const dispatch = (command: ClientOrchestrationCommand) =>
    normalizeDispatchCommand(command).pipe(
      Effect.flatMap((normalized) => engine.dispatch(normalized)),
    );

  const forkThread = Effect.fn("history.fork")(function* (input: HistoryForkInput) {
    const sourceSnapshot = yield* projectionSnapshotQuery
      .getThreadDetailSnapshot(input.threadId)
      .pipe(
        Effect.catch((cause) =>
          refuse("thread_not_found", `Could not read the source thread: ${String(cause)}`),
        ),
      );
    if (Option.isNone(sourceSnapshot)) {
      return yield* refuse("thread_not_found");
    }
    const source = sourceSnapshot.value.thread;

    // The binding is the only place a thread's provider session id exists.
    // Absent it, the thread has never started a session and there is nothing
    // to fork — which is a refusal rather than "fork an empty conversation",
    // because the caller can do that itself without a round trip.
    const binding = Option.getOrUndefined(
      yield* directory
        .getBinding(input.threadId)
        .pipe(
          Effect.catch((cause) =>
            refuse("no_resumable_session", `Could not read the session binding: ${String(cause)}`),
          ),
        ),
    );
    if (binding === undefined) {
      return yield* refuse(
        "no_resumable_session",
        "This thread has not started a session yet, so there is no conversation to fork.",
      );
    }
    // Provider before session id: "Codex cannot fork" is a permanent fact about
    // the thread and a better sentence than "no session found", which reads as
    // something waiting a turn would fix.
    if (!isForkableDriverKind(binding.provider)) {
      return yield* refuse(
        "provider_unsupported",
        `Forking a conversation needs a provider that can fork a session, and '${binding.provider}' cannot.`,
      );
    }
    const sourceSessionId = readForkableSessionId(binding.resumeCursor);
    if (sourceSessionId === null) {
      return yield* refuse(
        "no_resumable_session",
        "This thread has no provider session recorded yet — send it a message first.",
      );
    }

    const title =
      input.title !== undefined && input.title.trim().length > 0
        ? input.title.trim()
        : forkThreadTitle(source.title);
    const threadId = ThreadId.make(`thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);

    // The fork inherits where and how the source runs — project, branch,
    // worktree, model, permission and interaction mode. It does not inherit a
    // `titleSeed`: a seed invites the provider to rename the thread on its
    // first turn, and this thread's name is provenance.
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`fork-thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
      threadId,
      projectId: source.projectId,
      title,
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    } as unknown as ClientOrchestrationCommand).pipe(
      Effect.catch((cause) => refuse("thread_create_failed", String(cause))),
    );

    // The seam, and the one write that makes this a fork rather than a new
    // thread. `status: "stopped"` because no process exists yet; the row is
    // here only to be read by the fork's first `startSession`. The cwd comes
    // from the source binding rather than the project, because a thread on a
    // worktree runs somewhere its project does not and Claude's session store
    // is keyed by working directory.
    const cwd = readBindingCwd(binding.runtimePayload);
    yield* directory
      .upsert({
        threadId,
        provider: binding.provider,
        ...(binding.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: binding.providerInstanceId }),
        ...(binding.adapterKey === undefined ? {} : { adapterKey: binding.adapterKey }),
        runtimeMode: source.runtimeMode,
        status: "stopped",
        resumeCursor: forkResumeCursor({ threadId, sourceSessionId }),
        ...(cwd === null ? {} : { runtimePayload: { cwd } }),
      })
      .pipe(
        Effect.catch((cause) =>
          // Roll the thread back, exactly as import does. A fork that exists
          // but is not bound is worse than no fork at all: it is named after a
          // conversation it has never heard of.
          Effect.gen(function* () {
            yield* dispatch({
              type: "thread.delete",
              commandId: CommandId.make(
                `fork-rollback-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
              ),
              threadId,
            } as unknown as ClientOrchestrationCommand).pipe(Effect.ignore);
            return yield* new HistoryForkRefusal({
              reason: "binding_write_failed" satisfies HistoryForkRefusalReason,
              detail: String(cause),
            });
          }),
        ),
      );

    return {
      threadId,
      sourceThreadId: input.threadId,
      projectId: source.projectId,
      title,
      provider: "claude",
      sourceSessionId,
    } satisfies HistoryForkResult;
  });

  return { forkThread };
});
