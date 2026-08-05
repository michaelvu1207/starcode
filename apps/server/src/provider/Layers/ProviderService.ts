/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EnvironmentId,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  TurnId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderSetGoalInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderOptionSelections,
} from "@starcode/contracts";
import { causeErrorTag } from "@starcode/shared/observability";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  ProviderFeatureUnsupportedError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { createAttachedAgentCoordinator } from "../AttachedAgentCoordinator.ts";
import { setAttachedAgentHost, setAttachedAgentStartupRecovery } from "../AttachedAgentHost.ts";
const isModelSelection = Schema.is(ModelSelection);

export function redactCanonicalRuntimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  if (
    event.type !== "session.started" ||
    !event.payload.resume ||
    typeof event.payload.resume !== "object" ||
    Array.isArray(event.payload.resume)
  ) {
    return event;
  }
  const resume = event.payload.resume as Record<string, unknown>;
  if (!Object.hasOwn(resume, "pendingTurnInput") && !Object.hasOwn(resume, "pendingTurnInputs")) {
    return event;
  }
  const {
    pendingTurnInput: _pendingTurnInput,
    pendingTurnInputs: _pendingTurnInputs,
    ...safeResume
  } = resume;
  return {
    ...event,
    payload: {
      ...event.payload,
      resume: safeResume,
    },
  };
}

export const readPersistedAttachedAgentOptions = (
  value: unknown,
): ProviderOptionSelections | undefined => {
  if (!Array.isArray(value)) return undefined;
  const selections: Array<{ id: string; value: string | boolean }> = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const optionValue = record.value;
    if (
      id.length > 0 &&
      (typeof optionValue === "boolean" ||
        (typeof optionValue === "string" && optionValue.trim().length > 0))
    ) {
      selections.push({
        id,
        value: typeof optionValue === "string" ? optionValue.trim() : optionValue,
      });
    }
  }
  return selections.length > 0 ? selections : undefined;
};

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  /**
   * Resume the sessions that were alive at last shutdown when this service
   * starts. Defaults to true; tests set it false so building the layer does
   * not try to launch real provider processes.
   */
  readonly restoreSessionsOnStart?: boolean;
  /** Maximum time one persisted provider session may hold startup recovery. */
  readonly sessionRecoveryTimeout?: Duration.Input;
  /** Delay before retrying a startup recovery attempt that timed out. */
  readonly sessionRecoveryRetryDelay?: Duration.Input;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

export function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
  fallbackInstanceId?: ProviderInstanceId,
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  if (isModelSelection(raw)) return raw;

  // Attached-agent bindings written before modelSelection was persisted kept
  // the canonical model and options inside attachedAgent. Recover that legacy
  // shape so a restart cannot silently fall back to the adapter's default.
  const attached = "attachedAgent" in runtimePayload ? runtimePayload.attachedAgent : undefined;
  if (!fallbackInstanceId || !attached || typeof attached !== "object" || Array.isArray(attached)) {
    return undefined;
  }
  const record = attached as Record<string, unknown>;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (model.length === 0) return undefined;
  const options = readPersistedAttachedAgentOptions(record.options);
  const legacySelection = {
    instanceId: fallbackInstanceId,
    model,
    ...(options ? { options } : {}),
  };
  return isModelSelection(legacySelection) ? legacySelection : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedActiveTurnId(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): TurnId | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "activeTurnId" in runtimePayload ? runtimePayload.activeTurnId : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? TurnId.make(raw.trim()) : undefined;
}

function wasStoppedByLegacyServiceShutdown(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
): boolean {
  if (binding.status !== "stopped") return false;
  const payload = binding.runtimePayload;
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "lastRuntimeEvent" in payload &&
    payload.lastRuntimeEvent === "provider.stopAll"
  );
}

function isRetiredHistoryBinding(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding | undefined,
): boolean {
  // Pi is the sole executable runtime. Any other binding is retained only as
  // provenance, regardless of status or payload shape; stale registries and
  // test adapters must not be able to reactivate it after cutover.
  return binding !== undefined && binding.provider !== "pi";
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options: ProviderServiceLiveOptions | undefined,
  mcpSessionRegistry: McpSessionRegistry.McpSessionRegistryShape,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    mcpSessionRegistry.revokeThread(threadId).pipe(
      Effect.andThen(mcpSessionRegistry.issue({ threadId, providerInstanceId })),
      Effect.tap((credential) =>
        Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config)),
      ),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    mcpSessionRegistry
      .revokeThread(threadId)
      .pipe(
        Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(
              redactCanonicalRuntimeEvent(canonicalEvent),
              canonicalEvent.threadId,
            )
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const attachedAgents = createAttachedAgentCoordinator({
    resolveAdapter: (instanceId) =>
      Effect.runPromise(
        Effect.all({
          adapter: registry.getByInstance(instanceId),
          info: registry.getInstanceInfo(instanceId),
        }).pipe(
          Effect.map(({ adapter, info }) => ({
            adapter,
            driver: info.driverKind,
            enabled: info.enabled,
          })),
        ),
      ),
    parentRuntimeMode: (parentThreadId) =>
      Effect.runPromise(
        directory
          .getBinding(parentThreadId)
          .pipe(Effect.map((binding) => Option.getOrUndefined(binding)?.runtimeMode)),
      ),
    publish: (event) => Effect.runPromise(publishRuntimeEvent(event)),
    persist: (runtime) =>
      Effect.runPromise(
        directory.getBinding(runtime.virtualThreadId).pipe(
          Effect.flatMap((existingOption) => {
            const existing = Option.getOrUndefined(existingOption);
            return directory.upsert({
              ...existing,
              threadId: runtime.virtualThreadId,
              provider: runtime.driver,
              providerInstanceId: runtime.providerInstanceId,
              // Paused means the conversation is idle, not closed. Keep the
              // provider binding recoverable across a Starcode restart.
              status: "running",
              ...(runtime.resumeCursor !== undefined
                ? { resumeCursor: runtime.resumeCursor }
                : existing?.resumeCursor !== undefined
                  ? { resumeCursor: existing.resumeCursor }
                  : {}),
              runtimePayload: {
                ...(runtime.model
                  ? {
                      modelSelection: {
                        instanceId: runtime.providerInstanceId,
                        model: runtime.model,
                        ...(runtime.options ? { options: runtime.options } : {}),
                      },
                    }
                  : {}),
                attachedAgent: {
                  agentRunId: runtime.agentRunId,
                  parentThreadId: runtime.parentThreadId,
                  ...(runtime.parentAgentRunId
                    ? { parentAgentRunId: runtime.parentAgentRunId }
                    : {}),
                  description: runtime.description,
                  ...(runtime.model ? { model: runtime.model } : {}),
                  ...(runtime.options ? { options: runtime.options } : {}),
                  status: runtime.status,
                  updatedAt: runtime.updatedAt,
                  startedAt: runtime.startedAt,
                  continuationPrompt: runtime.continuationPrompt,
                },
              },
            });
          }),
        ),
      ),
    clearPersisted: (virtualThreadId) =>
      Effect.runPromise(
        directory.getBinding(virtualThreadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (binding) => directory.upsert({ ...binding, status: "stopped" }),
            }),
          ),
        ),
      ),
    prepareMcp: async (parentThreadId, virtualThreadId, instanceId) => {
      let config = McpProviderSession.readMcpProviderSession(parentThreadId);
      if (!config) {
        const credential = await Effect.runPromise(
          mcpSessionRegistry.revokeThread(parentThreadId).pipe(
            Effect.andThen(
              mcpSessionRegistry.issue({
                threadId: parentThreadId,
                providerInstanceId: instanceId,
              }),
            ),
          ),
        );
        config = credential.config;
      }
      McpProviderSession.setMcpProviderSession({
        ...config,
        threadId: virtualThreadId,
        providerInstanceId: instanceId,
      });
    },
    clearMcp: async (virtualThreadId) => {
      McpProviderSession.clearMcpProviderSession(virtualThreadId);
    },
  });
  setAttachedAgentHost(attachedAgents.host);
  setAttachedAgentStartupRecovery({
    awaitCompletion: attachedAgents.awaitStartupRecovery,
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      setAttachedAgentHost(undefined);
      setAttachedAgentStartupRecovery(undefined);
    }),
  );
  const suppressedAttachedRecovery = new Set<ThreadId>();
  const persistedAttachedBindings = yield* directory
    .listBindings()
    .pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    persistedAttachedBindings,
    (binding) => {
      if (
        (binding.status !== "running" && binding.status !== "starting") ||
        !binding.providerInstanceId ||
        !binding.runtimePayload ||
        typeof binding.runtimePayload !== "object" ||
        Array.isArray(binding.runtimePayload)
      ) {
        return Effect.void;
      }
      const attached = (binding.runtimePayload as Record<string, unknown>).attachedAgent;
      if (!attached || typeof attached !== "object" || Array.isArray(attached)) return Effect.void;
      // Generic provider recovery must never revive a virtual attached thread
      // unless its coordinator state has also been restored successfully.
      suppressedAttachedRecovery.add(binding.threadId);
      if (binding.provider !== "pi") {
        // Claude Code / Codex harness bindings can remain in databases from
        // older Alpha builds. They are history only now: do not resolve or
        // launch their removed adapters during startup. Mark the virtual
        // binding stopped; ProviderRuntimeIngestion's attached-run
        // reconciliation will project a visible terminal state once its
        // subscriptions are installed.
        return directory.upsert({ ...binding, status: "stopped" }).pipe(
          Effect.tap(() =>
            Effect.logInfo("retired non-Pi attached-agent runtime", {
              virtualThreadId: binding.threadId,
              provider: binding.provider,
            }),
          ),
        );
      }
      const record = attached as Record<string, unknown>;
      if (
        typeof record.agentRunId !== "string" ||
        typeof record.parentThreadId !== "string" ||
        typeof record.description !== "string" ||
        typeof record.startedAt !== "string"
      ) {
        return directory.upsert({ ...binding, status: "stopped" }).pipe(
          Effect.tap(() =>
            Effect.logWarning("retired malformed attached-agent runtime", {
              virtualThreadId: binding.threadId,
              providerInstanceId: binding.providerInstanceId,
            }),
          ),
        );
      }
      const agentRunId = record.agentRunId as string;
      const parentThreadId = record.parentThreadId as string;
      const description = record.description as string;
      const startedAt = record.startedAt as string;
      const restoredOptions = readPersistedAttachedAgentOptions(record.options);
      return Effect.gen(function* () {
        const terminalProjection = yield* directory
          .hasTerminalAttachedAgentProjection({
            parentThreadId: ThreadId.make(parentThreadId),
            provider: binding.provider,
            agentRunId,
          })
          .pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
                Effect.logWarning("could not reconcile attached agent before recovery", {
                  agentRunId,
                  parentThreadId,
                  virtualThreadId: binding.threadId,
                  errorTag: cause._tag,
                }).pipe(Effect.as(undefined)),
              onSuccess: Effect.succeed,
            }),
          );
        if (terminalProjection === undefined) return;
        if (terminalProjection) {
          yield* directory.upsert({ ...binding, status: "stopped" });
          yield* Effect.logInfo("suppressed stale attached-agent recovery", {
            agentRunId,
            parentThreadId,
            virtualThreadId: binding.threadId,
          });
          return;
        }
        yield* Effect.tryPromise(() =>
          attachedAgents.restore({
            snapshot: {
              agentRunId,
              parentThreadId: ThreadId.make(parentThreadId),
              ...(typeof record.parentAgentRunId === "string"
                ? { parentAgentRunId: record.parentAgentRunId as string }
                : {}),
              providerInstanceId: binding.providerInstanceId!,
              ...(typeof record.model === "string" ? { model: record.model as string } : {}),
              ...(restoredOptions ? { options: restoredOptions } : {}),
              description,
              status:
                record.status === "paused" || record.status === "completed"
                  ? record.status
                  : "running",
              startedAt,
              updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : startedAt,
            },
            virtualThreadId: binding.threadId,
            driver: binding.provider,
            continuationPrompt:
              typeof record.continuationPrompt === "string"
                ? (record.continuationPrompt as string)
                : "",
          }),
        );
        suppressedAttachedRecovery.delete(binding.threadId);
      }).pipe(
        Effect.catchCause((cause) =>
          directory.upsert({ ...binding, status: "stopped" }).pipe(
            Effect.catch((persistCause) =>
              Effect.logWarning("could not stop unrestorable attached-agent binding", {
                virtualThreadId: binding.threadId,
                providerInstanceId: binding.providerInstanceId,
                errorTag: persistCause._tag,
              }),
            ),
            Effect.andThen(
              Effect.logWarning("could not restore attached-agent runtime", {
                virtualThreadId: binding.threadId,
                providerInstanceId: binding.providerInstanceId,
                errorTag: causeErrorTag(cause),
              }),
            ),
          ),
        ),
      );
    },
    { concurrency: 1, discard: true },
  );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        Effect.tryPromise(() => attachedAgents.handleRuntimeEvent(canonicalEvent)).pipe(
          Effect.flatMap((handled) =>
            increment(providerRuntimeEventsTotal, {
              provider: canonicalEvent.provider,
              eventType: canonicalEvent.type,
            }).pipe(Effect.andThen(handled ? Effect.void : publishRuntimeEvent(canonicalEvent))),
          ),
          Effect.orDie,
        ),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    if (isRetiredHistoryBinding(input.binding)) {
      return yield* toValidationError(
        input.operation,
        `Thread '${input.binding.threadId}' is bound to retired provider '${input.binding.provider}' and is read-only. Start a new Pi thread to continue.`,
      );
    }
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(
        input.binding.runtimePayload,
        bindingInstanceId,
      );
      const persistedActiveTurnId = readPersistedActiveTurnId(input.binding.runtimePayload);

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          ...(persistedActiveTurnId ? { activeTurnId: persistedActiveTurnId } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      if (persistedBinding && isRetiredHistoryBinding(persistedBinding)) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Thread '${threadId}' is bound to retired provider '${persistedBinding.provider}' and is read-only. Start a new Pi thread to continue.`,
        );
      }
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in starcode settings.`,
          );
        }
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* prepareMcpSession(threadId, resolvedInstanceId);
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise(() => attachedAgents.host.cancelParent(input.threadId)).pipe(
          Effect.orDie,
        );
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const attachedRoute = attachedAgents.findRequestRoute(String(input.requestId));
        if (attachedRoute) {
          metricProvider = attachedRoute.adapter.provider;
          yield* attachedRoute.adapter.respondToRequest(
            attachedRoute.virtualThreadId,
            input.requestId,
            input.decision,
          );
          return;
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const attachedRoute = attachedAgents.findRequestRoute(String(input.requestId));
      if (attachedRoute) {
        metricProvider = attachedRoute.adapter.provider;
        yield* attachedRoute.adapter.respondToUserInput(
          attachedRoute.virtualThreadId,
          input.requestId,
          input.answers,
        );
        return;
      }
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise(() => attachedAgents.host.cancelParent(input.threadId)).pipe(
          Effect.orDie,
        );
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const requireGoalControl = (
    operation: string,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    adapter.capabilities.goalControl === "native"
      ? Effect.succeed(adapter)
      : Effect.fail(
          new ProviderFeatureUnsupportedError({
            provider: adapter.provider,
            feature: "goals",
          }),
        ).pipe(Effect.withSpan(operation));

  const getGoal: ProviderServiceMethod<"getGoal"> = Effect.fn("getGoal")(function* (threadId) {
    const routed = yield* resolveRoutableSession({
      threadId,
      operation: "ProviderService.getGoal",
      allowRecovery: true,
    });
    const adapter = yield* requireGoalControl("ProviderService.getGoal", routed.adapter);
    if (!adapter.getGoal) {
      return yield* Effect.die(
        new Error(`${adapter.provider} declares native goal control without getGoal`),
      );
    }
    return yield* adapter.getGoal(threadId);
  });

  const setGoal: ProviderServiceMethod<"setGoal"> = Effect.fn("setGoal")(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.setGoal",
      schema: ProviderSetGoalInput,
      payload: rawInput,
    });
    if (
      input.objective === undefined &&
      input.status === undefined &&
      input.tokenBudget === undefined
    ) {
      return yield* toValidationError(
        "ProviderService.setGoal",
        "At least one goal field must be provided",
      );
    }
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.setGoal",
      allowRecovery: true,
    });
    const adapter = yield* requireGoalControl("ProviderService.setGoal", routed.adapter);
    if (!adapter.setGoal) {
      return yield* Effect.die(
        new Error(`${adapter.provider} declares native goal control without setGoal`),
      );
    }
    return yield* adapter.setGoal(input);
  });

  const clearGoal: ProviderServiceMethod<"clearGoal"> = Effect.fn("clearGoal")(
    function* (threadId) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.clearGoal",
        allowRecovery: true,
      });
      const adapter = yield* requireGoalControl("ProviderService.clearGoal", routed.adapter);
      if (!adapter.clearGoal) {
        return yield* Effect.die(
          new Error(`${adapter.provider} declares native goal control without clearGoal`),
        );
      }
      return yield* adapter.clearGoal(threadId);
    },
  );

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    // Preserve the resumable status of sessions that were alive when this
    // service began shutting down. A graceful app/dev-server restart is not an
    // operator stop: rewriting these bindings to `stopped` would make startup
    // recovery skip them and strand any projected running turn forever.
    const activeThreadIds = new Set(activeSessions.map((session) => session.threadId));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* mcpSessionRegistry.revokeAll;
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      activeThreadIds.has(binding.threadId)
        ? Effect.void
        : Effect.gen(function* () {
            const providerInstanceId = dieOnMissingBindingInstanceId(
              "ProviderService.stopAll",
              binding,
            );
            return yield* directory.upsert({
              threadId: binding.threadId,
              provider: binding.provider,
              providerInstanceId,
              status: "stopped",
              runtimePayload: {
                activeTurnId: null,
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt: yield* nowIso,
              },
            });
          }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  /**
   * Bring back the sessions that were alive when this process last stopped.
   *
   * Recovery itself is not new — `recoverSessionForThread` resumes from the
   * persisted cursor and mints a fresh MCP credential. What was missing is a
   * trigger: the only caller was `routeThread`, which runs when a command
   * arrives, so after a server restart every thread sat dead until somebody
   * hand-poked it. The provider processes are driven over this server's stdio,
   * so a restart kills all of them at once and there is nobody left to do the
   * poking.
   *
   * `running` and `starting` rows are normally eligible. A stopped row is also
   * eligible only when it carries the old service-shutdown marker and the
   * canonical projection still proves that exact thread owns a running turn.
   * That repairs rows written by the pre-fix finalizer without reviving an
   * intentionally stopped thread. A row with no resume cursor is skipped.
   *
   * Every thread is recovered independently and its failure is logged, never
   * propagated: one dead session must not take down the boot of the service
   * that owns all the others. Forked, so a slow provider launch delays no
   * other startup work.
   */
  const restoreRunningSessions = Effect.gen(function* () {
    const bindings = yield* directory.listBindings();
    const eligibleFlags = yield* Effect.forEach(
      bindings,
      (binding) => {
        if (binding.provider !== "pi") {
          // Legacy Claude Code / Codex runtime bindings are retained only as
          // history pointers. Never resolve their removed adapters during
          // startup, even if a stale or test registry still advertises one.
          // Preserve the cursor and payload so history/provenance remains
          // inspectable; only retire the executable lifecycle state.
          return binding.status === "running" || binding.status === "starting"
            ? directory.upsert({ ...binding, status: "stopped" }).pipe(
                Effect.tap(() =>
                  Effect.logInfo("retired non-Pi provider runtime", {
                    threadId: binding.threadId,
                    provider: binding.provider,
                  }),
                ),
                Effect.as(false),
              )
            : Effect.succeed(false);
        }
        const hasResumeCursor = binding.resumeCursor !== null && binding.resumeCursor !== undefined;
        if (!hasResumeCursor || suppressedAttachedRecovery.has(binding.threadId)) {
          return Effect.succeed(false);
        }
        if (binding.status === "running" || binding.status === "starting") {
          return Effect.succeed(true);
        }
        if (!wasStoppedByLegacyServiceShutdown(binding)) {
          return Effect.succeed(false);
        }
        return directory.hasRecoverableProjectedTurn(binding.threadId);
      },
      { concurrency: 4 },
    );
    const eligible = bindings.filter((_binding, index) => eligibleFlags[index] === true);
    const skipped = bindings.length - eligible.length;
    if (eligible.length === 0) {
      yield* Effect.logInfo("no provider sessions to restore", {
        bindings: bindings.length,
        skipped,
      });
      return;
    }
    yield* Effect.logInfo("restoring provider sessions after restart", {
      eligible: eligible.length,
      skipped,
    });
    const outcomes = yield* Effect.forEach(
      eligible,
      (binding) =>
        recoverSessionForThread({
          binding,
          operation: "ProviderService.restoreRunningSessions",
        }).pipe(
          Effect.tap(() =>
            Effect.tryPromise((signal) => attachedAgents.resume(binding.threadId, signal)).pipe(
              Effect.orDie,
            ),
          ),
          Effect.timeout(options?.sessionRecoveryTimeout ?? Duration.seconds(30)),
          Effect.tapError((cause) =>
            Cause.isTimeoutError(cause)
              ? Effect.logWarning(
                  "provider session recovery timed out; retrying without stopping it",
                  {
                    threadId: binding.threadId,
                    provider: binding.provider,
                  },
                )
              : Effect.void,
          ),
          Effect.retry({
            while: Cause.isTimeoutError,
            schedule: Schedule.spaced(options?.sessionRecoveryRetryDelay ?? Duration.seconds(1)),
          }),
          Effect.as(true),
          Effect.catchCause((cause) =>
            directory.upsert({ ...binding, status: "stopped" }).pipe(
              Effect.catch((persistCause) =>
                Effect.logWarning("could not stop unrestorable provider binding", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  errorTag: persistCause._tag,
                }),
              ),
              Effect.andThen(
                Effect.logWarning("could not restore provider session", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  errorTag: causeErrorTag(cause),
                }),
              ),
              Effect.as(false),
            ),
          ),
        ),
      // Bounded: each recovery spawns a provider process, and launching a
      // dozen agents at once on one machine is how a restart turns into a
      // thundering herd.
      { concurrency: 4 },
    );
    const restored = outcomes.filter(Boolean).length;
    yield* Effect.logInfo("provider session restore complete", {
      restored,
      failed: outcomes.length - restored,
      skipped,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("provider session restore did not run", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.ensuring(Effect.sync(attachedAgents.completeStartupRecovery)),
  );

  if (options?.restoreSessionsOnStart !== false) {
    yield* restoreRunningSessions.pipe(Effect.forkScoped);
  } else {
    attachedAgents.completeStartupRecovery();
  }

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    getGoal,
    setGoal,
    clearGoal,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  McpSessionRegistry.McpSessionRegistry.pipe(
    Effect.flatMap((registry) => makeProviderService(undefined, registry)),
  ),
);

const TestMcpSessionRegistry = McpSessionRegistry.McpSessionRegistry.of({
  issue: ({ threadId, providerInstanceId }) =>
    Effect.succeed({
      config: {
        environmentId: EnvironmentId.make("provider-service-test"),
        threadId,
        providerSessionId: `provider-session-${threadId}`,
        providerInstanceId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer provider-service-test",
      },
      expiresAt: Number.POSITIVE_INFINITY,
    }),
  resolve: () => Effect.succeed(undefined),
  revokeProviderSession: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
});

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(
    ProviderService.ProviderService,
    makeProviderService(options, TestMcpSessionRegistry),
  );
}
