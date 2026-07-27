/**
 * LocalThreadWriter - starting a thread on the machine you are already on.
 *
 * `PeerThreadWriter.createThread` does this for another environment: resolve the
 * project, resolve the model, then send `thread.create` and `thread.turn.start`
 * over HTTP. This is the same shape with the transport removed — the catalog
 * and the project shell are read from the local services, and the two commands
 * go straight to `OrchestrationEngineService`.
 *
 * Deliberately a separate module from `PeerThreadWriter` rather than a `peer?`
 * on it. That module is "the write half of federation" and every one of its
 * operations either resolves a registry entry or classifies an HTTP failure;
 * neither exists here. What *is* shared is the part worth sharing — the
 * placement and model-default rules in `peerProjectPlacement.ts`, which are pure
 * and reused verbatim. (Their `peer*` names are now a mild lie. Renaming them is
 * a follow-up, not a reason to duplicate the rules.)
 *
 * Still two dispatches rather than one `thread.turn.start` carrying a
 * `bootstrap.createThread` block, for the reason `PeerThreadWriter` documents:
 * only the WebSocket handler unpacks that block, and everything else hands the
 * command to the engine, whose decider then rejects a turn on a thread that does
 * not exist yet. `ws.ts` dispatches the same pair in the same order.
 *
 * @module LocalThreadWriter
 */
import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectCategoryRecord,
  type ProjectCategorySlug,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadCreateResult,
  ThreadId,
  ThreadToolError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  choosePeerProjectLocation,
  resolvePeerThreadModelSelection,
  resolvePeerThreadModes,
} from "../peers/peerProjectPlacement.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";

/**
 * How many threads one caller may create in a single turn.
 *
 * This is the runaway backstop, and it is load-bearing precisely because
 * `thread_create` is not master-gated: nothing stops a created thread from
 * calling `thread_create` itself, and unlike the peer form every descendant
 * competes for *this* machine's CPU, provider quota and money.
 *
 * A per-turn cap rather than a depth limit, because depth is not knowable —
 * threads carry no parentage, and giving them some purely to count generations
 * would be a schema change in service of a guard. A per-turn cap needs no
 * persistence and still bounds exponential growth: each generation has to spend
 * its own turns to widen, so a fan-out cannot outrun the operator watching it.
 *
 * Three is chosen to be obviously enough for delegation and obviously not enough
 * to be a fork bomb.
 */
export const LOCAL_THREAD_CREATE_PER_TURN_LIMIT = 3;

export interface LocalThreadCreateOptions {
  /** The caller, for the per-turn cap. Not recorded on the new thread. */
  readonly callerThreadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
  readonly project?: ProjectCategorySlug | undefined;
  readonly title: string;
  readonly message: string;
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}

export interface LocalThreadWriterShape {
  readonly createThread: (
    options: LocalThreadCreateOptions,
  ) => Effect.Effect<ThreadCreateResult, ThreadToolError>;
}

export class LocalThreadWriter extends Context.Service<LocalThreadWriter, LocalThreadWriterShape>()(
  "t3/threads/LocalThreadWriter",
) {}

const failure = (reason: ThreadToolError["reason"], detail?: string) =>
  new ThreadToolError({
    operation: "create",
    reason,
    ...(detail === undefined ? {} : { detail }),
  });

interface TurnAllowance {
  readonly key: string;
  readonly used: number;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const catalog = yield* ProjectCatalogRegistry;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  /**
   * One allowance per caller, replaced rather than accumulated when the turn key
   * changes. Keyed by thread rather than by (thread, turn) so the map cannot
   * grow without bound over a long-lived session — a thread only ever has one
   * live turn, so the previous turn's count is never needed again.
   *
   * In-memory on purpose: this is a backstop against a loop inside one process,
   * and a restart is not a hole an attacker walks through — it is the operator
   * having already noticed.
   */
  const allowances = yield* SynchronizedRef.make(new Map<string, TurnAllowance>());

  /**
   * The caller's live turn, which is what the allowance is scoped to.
   *
   * Resolved here rather than taken from the tool call for the same reason
   * `resolveOrigin` resolves provenance from server state: a caller that could
   * name its own turn could name a fresh one every time and the cap would be
   * decoration. A thread with no turn at all should not be reachable — the MCP
   * session exists because a turn is running — so the fallback is a constant
   * that shares one allowance rather than an unbounded key space.
   */
  const resolveTurnKey = (callerThreadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(callerThreadId).pipe(
      Effect.map((thread) =>
        Option.match(thread, {
          onNone: () => "no-thread",
          onSome: (value) => value.latestTurn?.turnId ?? "no-turn",
        }),
      ),
      Effect.catchCause(() => Effect.succeed("no-turn")),
    );

  const chargeTurnAllowance = (callerThreadId: ThreadId, callerTurnKey: string) =>
    SynchronizedRef.modify(allowances, (current) => {
      const existing = current.get(callerThreadId);
      const used = existing !== undefined && existing.key === callerTurnKey ? existing.used : 0;
      if (used >= LOCAL_THREAD_CREATE_PER_TURN_LIMIT) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.set(callerThreadId, { key: callerTurnKey, used: used + 1 });
      return [true, next] as const;
    });

  /**
   * Where the thread lands, and the category whose defaults it inherits.
   *
   * A slug is resolved through the catalog exactly as the peer path resolves it
   * through the peer's catalog, and refuses the same two ways: a project that
   * binds no folder is legal but is not somewhere a thread can start, and one
   * that binds several with no preference is a question rather than a default.
   */
  const resolvePlacement = Effect.fn("LocalThreadWriter.resolvePlacement")(function* (
    options: LocalThreadCreateOptions,
  ): Effect.fn.Return<
    { readonly projectId: ProjectId; readonly category: ProjectCategoryRecord | null },
    ThreadToolError
  > {
    if (options.project === undefined) {
      if (options.projectId === undefined) {
        return yield* failure(
          "project_not_found",
          "Say where the thread goes: pass project (a slug, as project_list reports it) or projectId (this machine's own folder id).",
        );
      }
      return { projectId: options.projectId, category: null };
    }

    const categories = yield* catalog.list.pipe(
      Effect.mapError((cause) =>
        failure("dispatch_failed", `Could not read the project catalog: ${String(cause)}`),
      ),
    );
    const category = categories.find((entry) => entry.slug === options.project);
    if (category === undefined) {
      return yield* failure(
        "project_not_found",
        `No project '${options.project}' on this machine. Its projects are: ${
          categories.map((entry) => entry.slug).join(", ") || "(none)"
        }.`,
      );
    }

    const choice = choosePeerProjectLocation(category);
    if (choice.kind === "unbound") {
      return yield* failure(
        "project_not_found",
        `Project '${options.project}' binds no folder here, so there is nowhere to start the thread. Bind a location first, or pass projectId.`,
      );
    }
    if (choice.kind === "ambiguous") {
      return yield* failure(
        "project_not_found",
        `Project '${options.project}' binds ${choice.projectIds.length} folders and names no preferred one, so which to start the thread in is ambiguous. Pass projectId — the candidates are: ${choice.projectIds.join(", ")}.`,
      );
    }
    return { projectId: choice.projectId, category };
  });

  const createThread: LocalThreadWriterShape["createThread"] = Effect.fn(
    "LocalThreadWriter.createThread",
  )(function* (options) {
    // Charged before any work, so a caller in a loop pays the refusal on the
    // cheap path rather than after two service reads.
    const turnKey = yield* resolveTurnKey(options.callerThreadId);
    const allowed = yield* chargeTurnAllowance(options.callerThreadId, turnKey);
    if (!allowed) {
      return yield* failure(
        "rate_limited",
        `A thread may create at most ${LOCAL_THREAD_CREATE_PER_TURN_LIMIT} threads per turn. Let this turn finish, or have one of the threads you already started do the rest.`,
      );
    }

    const placement = yield* resolvePlacement(options);

    const project = yield* projectionSnapshotQuery
      .getProjectShellById(placement.projectId)
      .pipe(
        Effect.mapError((cause) =>
          failure(
            "dispatch_failed",
            `Could not read project '${placement.projectId}': ${String(cause)}`,
          ),
        ),
      );
    if (Option.isNone(project)) {
      return yield* failure(
        "project_not_found",
        `No folder '${placement.projectId}' on this machine. Use project_list to see what is bound.`,
      );
    }

    const overrides = {
      instanceId: options.instanceId,
      model: options.model,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
    };
    const modelSelection: ModelSelection | null = resolvePeerThreadModelSelection({
      locationDefault: project.value.defaultModelSelection,
      categoryDefault: placement.category?.local.defaults.modelSelection,
      overrides,
    });
    if (modelSelection === null) {
      return yield* failure(
        "model_unavailable",
        `Project '${placement.projectId}' has no default model, so instanceId and model must both be given.`,
      );
    }

    const threadId = ThreadId.make(`thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const { runtimeMode, interactionMode } = resolvePeerThreadModes({
      ...(placement.category === null ? {} : { category: placement.category }),
      overrides,
    });

    const dispatch = (command: ClientOrchestrationCommand) =>
      engine
        .dispatch(command as never)
        .pipe(
          Effect.mapError((cause) =>
            failure(
              "dispatch_failed",
              `The orchestration engine refused the command: ${String(cause)}`,
            ),
          ),
        );

    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`local-create-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
      threadId,
      projectId: placement.projectId,
      title: options.title,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: null,
      worktreePath: null,
      createdAt,
    } as unknown as ClientOrchestrationCommand);

    yield* dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(
        `local-first-turn-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
      ),
      threadId,
      message: {
        messageId: MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
        role: "user",
        text: options.message,
        attachments: [],
      },
      runtimeMode,
      interactionMode,
      createdAt,
    } as unknown as ClientOrchestrationCommand);

    return {
      threadId,
      projectId: placement.projectId,
      title: options.title,
      modelSelection,
    } satisfies ThreadCreateResult;
  });

  return LocalThreadWriter.of({ createThread });
});

export const layer: Layer.Layer<
  LocalThreadWriter,
  never,
  OrchestrationEngineService | ProjectCatalogRegistry | ProjectionSnapshotQuery | Crypto.Crypto
> = Layer.effect(LocalThreadWriter, make);
