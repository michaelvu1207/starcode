/**
 * LocalThreadWriter - starting and reaching threads on the machine you are
 * already on.
 *
 * Two operations, both of which `PeerThreadWriter` does for another environment
 * over HTTP and both of which are the same shape here with the transport
 * removed: `createThread` resolves the project and model then sends
 * `thread.create` and `thread.turn.start`, and `deliverMessage` sends the
 * `thread.turn.start` that hands a running or idle thread a message. The catalog
 * and the project shell are read from the local services, and every command goes
 * straight to `OrchestrationEngineService`.
 *
 * Deliberately a separate module from `PeerThreadWriter` rather than a `peer?`
 * on it. That module is "the write half of federation" and every one of its
 * operations either resolves a registry entry or classifies an HTTP failure;
 * neither exists here. What *is* shared is the part worth sharing — the
 * placement and model-default rules in `threadPlacement.ts`, which are pure and
 * reused verbatim by both writers.
 *
 * Two dispatches rather than one `thread.turn.start` carrying a
 * `bootstrap.createThread` block, and this is settled rather than pending.
 *
 * The block is unpacked only by `ws.ts`, so anything handing the command
 * straight to the engine gets a decider that rejects a turn on a thread which
 * does not exist yet. That reads like a seam worth closing until you read what
 * the socket handler actually does with it: `dispatchBootstrapTurnStart` also
 * fetches a remote, creates a git worktree, updates the thread's branch meta,
 * runs the project's setup scripts, and deletes the thread it just made if any
 * of that fails. Teaching the engine to unpack the block would drag git and
 * setup-script execution into the one component that is supposed to be a pure
 * command-to-event boundary; teaching it to unpack only the `createThread` half
 * would leave one field with two handlers that must agree.
 *
 * So the pair stays. Two dispatches at each of the two write sites is cheaper
 * than either of those, and the part actually worth sharing — placement and the
 * model and mode defaults — already lives in `threadPlacement.ts`.
 *
 * @module LocalThreadWriter
 */
import {
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
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
} from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  chooseProjectLocation,
  resolveThreadModelSelection,
  resolveThreadModes,
} from "../peers/threadPlacement.ts";
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

/**
 * How many threads one caller may wake in a single turn.
 *
 * The other half of the backstop, and the reason it is needed at all: a mailbox
 * message could not cause a turn, so agent-to-agent chatter could not loop no
 * matter how enthusiastic it got. Delivering immediately trades that structural
 * guarantee away, and this is part of what replaces it.
 *
 * Width is bounded here and depth deliberately is not, because the two are not
 * the same risk. Fan-out is exponential — five threads waking five apiece, each
 * of those waking five — and it outruns the operator before they can look. A
 * chain is linear: one message, one turn, then one more, each costing minutes of
 * wall clock and real money, in full view of the sidebar the whole way. That is
 * a conversation happening slowly, not a runaway, and threads holding a
 * conversation is the feature.
 *
 * A depth cap was built and removed. Its failure mode was the defect this whole
 * path exists to remove: past the limit a message downgraded to the mailbox,
 * where an idle thread would not read it until something else woke it. A code
 * review or a debugging exchange passes three hops without trying, so the guard
 * fired on collaboration and left it looking broken in exactly the old way.
 *
 * Five rather than three: talking is cheaper than spawning, and a thread
 * reporting to a handful of siblings at the end of a piece of work is ordinary
 * rather than suspicious.
 */
export const THREAD_WAKE_PER_TURN_LIMIT = 5;

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

export interface LocalThreadDeliverOptions {
  /** The sender, for the per-turn cap. Not recorded on the target thread. */
  readonly callerThreadId: ThreadId;
  /** The thread being handed the message. */
  readonly threadId: ThreadId;
  /**
   * Exactly what the thread will receive, envelope and all. Rendered by the
   * caller rather than here: this module knows how to start a turn, and the
   * envelope belongs to the mailbox, which owns the trust boundary it states.
   */
  readonly text: string;
}

/**
 * `rate_limited` is a refusal the caller is expected to handle rather than
 * report — `peer_thread_send` answers it by queueing the message instead — so
 * it comes back as a value. A genuine engine refusal is still an error.
 */
export type LocalThreadDeliverOutcome = "delivered" | "rate_limited";

export interface LocalThreadWriterShape {
  readonly createThread: (
    options: LocalThreadCreateOptions,
  ) => Effect.Effect<ThreadCreateResult, ThreadToolError>;
  /**
   * Hands a message to a thread on this machine as the text of a turn: it
   * starts one on an idle thread, and joins the turn a working thread is
   * already taking. The same thing the operator's composer does.
   */
  readonly deliverMessage: (
    options: LocalThreadDeliverOptions,
  ) => Effect.Effect<LocalThreadDeliverOutcome, ThreadToolError>;
  /**
   * Spends one of the sender's wakes for this turn, reporting whether it had one
   * left. `deliverMessage` charges this itself; the federation writer calls it
   * directly before waking a thread on another machine.
   *
   * Exposed rather than duplicated because the budget belongs to the *sender*,
   * and the sender is on this machine either way. A thread that wakes three
   * threads here and three on a peer has fanned out six times, and two separate
   * counters would let it do exactly that while each one reported it was within
   * its limit.
   */
  readonly chargeWakeAllowance: (callerThreadId: ThreadId) => Effect.Effect<boolean>;
}

export class LocalThreadWriter extends Context.Service<LocalThreadWriter, LocalThreadWriterShape>()(
  "starcode/threads/LocalThreadWriter",
) {}

const failure = (
  operation: ThreadToolError["operation"],
  reason: ThreadToolError["reason"],
  detail?: string,
) =>
  new ThreadToolError({
    operation,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });

const createFailure = (reason: ThreadToolError["reason"], detail?: string) =>
  failure("create", reason, detail);

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
  const makeAllowance = (limit: number) =>
    Effect.map(SynchronizedRef.make(new Map<string, TurnAllowance>()), (allowances) => ({
      charge: (callerThreadId: ThreadId, callerTurnKey: string) =>
        SynchronizedRef.modify(allowances, (current) => {
          const existing = current.get(callerThreadId);
          const used = existing !== undefined && existing.key === callerTurnKey ? existing.used : 0;
          if (used >= limit) {
            return [false, current] as const;
          }
          const next = new Map(current);
          next.set(callerThreadId, { key: callerTurnKey, used: used + 1 });
          return [true, next] as const;
        }),
    }));

  /**
   * Two budgets rather than one shared counter, because the two operations are
   * not substitutes. A thread that has spent its creation budget delegating
   * work is precisely the thread that then needs to tell those threads
   * something, and a single counter would mute it exactly when it had the most
   * to say. They also bound different harms: creating threads competes for this
   * machine's CPU and quota, while waking one costs that thread a turn.
   */
  const createAllowance = yield* makeAllowance(LOCAL_THREAD_CREATE_PER_TURN_LIMIT);
  const wakeAllowance = yield* makeAllowance(THREAD_WAKE_PER_TURN_LIMIT);

  /**
   * One wake at a time per target thread.
   *
   * `Stream.runForEach` serializes how the reactor *processes* events, but the
   * provider call it makes is forked, so two wakes arriving back to back have
   * their `sendTurn` calls in flight together — and `ProviderService.sendTurn`
   * has no serialization of its own. Two concurrent sends can then both observe
   * an idle thread and open two turns on it, or restart the session under each
   * other. Holding a per-target semaphore across the dispatch keeps the pair
   * ordered, which is all that is needed: the second one steers into the turn
   * the first started, which is the intended behaviour for a busy thread.
   *
   * This does not order an agent's wake against the operator typing at the same
   * moment — that race predates this feature and lives further down, in the
   * provider layer.
   */
  const targetLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const lockForTarget = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(targetLocks, (current) => {
      const existing = current.get(threadId);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Effect.map(Semaphore.make(1), (semaphore) => {
        const next = new Map(current);
        next.set(threadId, semaphore);
        return [semaphore, next] as const;
      });
    });

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

  /**
   * Hoisted out of `createThread` so `deliverMessage` dispatches the same way.
   * Both failures are the engine refusing a command, and a caller reading one
   * should not have to work out whether the wording differs for a reason.
   */
  const dispatch = (operation: ThreadToolError["operation"], command: ClientOrchestrationCommand) =>
    engine
      .dispatch(command as never)
      .pipe(
        Effect.mapError((cause) =>
          failure(
            operation,
            "dispatch_failed",
            `The orchestration engine refused the command: ${String(cause)}`,
          ),
        ),
      );

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
        return yield* createFailure(
          "project_not_found",
          "Say where the thread goes: pass project (a slug, as project_list reports it) or projectId (this machine's own folder id).",
        );
      }
      return { projectId: options.projectId, category: null };
    }

    const categories = yield* catalog.list.pipe(
      Effect.mapError((cause) =>
        createFailure("dispatch_failed", `Could not read the project catalog: ${String(cause)}`),
      ),
    );
    const category = categories.find((entry) => entry.slug === options.project);
    if (category === undefined) {
      return yield* createFailure(
        "project_not_found",
        `No project '${options.project}' on this machine. Its projects are: ${
          categories.map((entry) => entry.slug).join(", ") || "(none)"
        }.`,
      );
    }

    const choice = chooseProjectLocation(category);
    if (choice.kind === "unbound") {
      return yield* createFailure(
        "project_not_found",
        `Project '${options.project}' binds no folder here, so there is nowhere to start the thread. Bind a location first, or pass projectId.`,
      );
    }
    if (choice.kind === "ambiguous") {
      return yield* createFailure(
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
    const allowed = yield* createAllowance.charge(options.callerThreadId, turnKey);
    if (!allowed) {
      return yield* createFailure(
        "rate_limited",
        `A thread may create at most ${LOCAL_THREAD_CREATE_PER_TURN_LIMIT} threads per turn. Let this turn finish, or have one of the threads you already started do the rest.`,
      );
    }

    const placement = yield* resolvePlacement(options);

    const project = yield* projectionSnapshotQuery
      .getProjectShellById(placement.projectId)
      .pipe(
        Effect.mapError((cause) =>
          createFailure(
            "dispatch_failed",
            `Could not read project '${placement.projectId}': ${String(cause)}`,
          ),
        ),
      );
    if (Option.isNone(project)) {
      return yield* createFailure(
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
    const modelSelection: ModelSelection | null = resolveThreadModelSelection({
      locationDefault: project.value.defaultModelSelection,
      categoryDefault: placement.category?.local.defaults.modelSelection,
      overrides,
    });
    if (modelSelection === null) {
      return yield* createFailure(
        "model_unavailable",
        `Project '${placement.projectId}' has no default model, so instanceId and model must both be given.`,
      );
    }

    const threadId = ThreadId.make(`thread-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const { runtimeMode, interactionMode } = resolveThreadModes({
      ...(placement.category === null ? {} : { category: placement.category }),
      overrides,
    });

    yield* dispatch("create", {
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

    yield* dispatch("create", {
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

  const chargeWakeAllowance: LocalThreadWriterShape["chargeWakeAllowance"] = Effect.fn(
    "LocalThreadWriter.chargeWakeAllowance",
  )(function* (callerThreadId) {
    const turnKey = yield* resolveTurnKey(callerThreadId);
    return yield* wakeAllowance.charge(callerThreadId, turnKey);
  });

  const deliverMessageUnlocked = Effect.fn("LocalThreadWriter.deliverMessageUnlocked")(function* (
    options: LocalThreadDeliverOptions,
  ) {
    // Charged first, for the same reason `createThread` charges first: a caller
    // in a loop should pay the refusal before any service read.
    if (!(yield* chargeWakeAllowance(options.callerThreadId))) {
      return "rate_limited";
    }

    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    /**
     * A plain `thread.turn.start`, which is exactly what the operator's composer
     * sends. That is the whole mechanism: the decider appends the user message
     * and requests a turn, and the provider layer decides what that means for a
     * thread that is already working — a steer into the running turn rather than
     * a second one. Nothing here reimplements either behaviour.
     *
     * The two modes are schema ballast rather than a decision, the same way they
     * are in `PeerThreadWriter.dispatchThread`: the decider reads the *target
     * thread's* stored modes for the turn it starts and ignores what is passed
     * here. They still have to decode, so they carry the app-wide defaults
     * instead of a stricter pair that would read as an intent this call does not
     * have.
     */
    yield* dispatch("deliver", {
      type: "thread.turn.start",
      commandId: CommandId.make(`local-deliver-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
      threadId: options.threadId,
      message: {
        messageId: MessageId.make(`msg-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`),
        role: "user",
        // The whole reason the field exists. Everything downstream that treats
        // an agent's message differently — the titler, the transcript card —
        // reads this rather than inspecting the text.
        authoredBy: "agent",
        text: options.text,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt,
    } as unknown as ClientOrchestrationCommand);

    return "delivered" as const;
  });

  const deliverMessage: LocalThreadWriterShape["deliverMessage"] = Effect.fn(
    "LocalThreadWriter.deliverMessage",
  )(function* (options) {
    const lock = yield* lockForTarget(options.threadId);
    return yield* lock.withPermits(1)(deliverMessageUnlocked(options));
  });

  return LocalThreadWriter.of({ createThread, deliverMessage, chargeWakeAllowance });
});

export const layer: Layer.Layer<
  LocalThreadWriter,
  never,
  OrchestrationEngineService | ProjectCatalogRegistry | ProjectionSnapshotQuery | Crypto.Crypto
> = Layer.effect(LocalThreadWriter, make);
