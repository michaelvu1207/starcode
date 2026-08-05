// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@starcode/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@starcode/contracts";
import { createModelSelection } from "@starcode/shared/model";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import {
  makeProviderServiceLive,
  redactCanonicalRuntimeEvent,
  readPersistedAttachedAgentOptions,
  readPersistedModelSelection,
} from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import {
  readAttachedAgentStartupRecovery,
  requireAttachedAgentHost,
} from "../AttachedAgentHost.ts";

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);

it("redacts durable pending Pi input only from the canonical provider log event", () => {
  const original: ProviderRuntimeEvent = {
    eventId: asEventId("evt-redact-pending-pi-input"),
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId: ProviderInstanceId.make("pi"),
    threadId: ThreadId.make("thread-redact-pending-pi-input"),
    createdAt: "2026-08-04T00:00:00.000Z",
    type: "session.started",
    payload: {
      message: "Embedded Pi session started",
      resume: {
        sessionId: "pi-session",
        sessionFile: "/tmp/pi-session.jsonl",
        pendingTurnInputs: [{ input: "never write this prompt to provider logs" }],
      },
    },
  };

  const redacted = redactCanonicalRuntimeEvent(original);

  assert.deepEqual(redacted, {
    ...original,
    payload: {
      ...original.payload,
      resume: {
        sessionId: "pi-session",
        sessionFile: "/tmp/pi-session.jsonl",
      },
    },
  });
  assert.deepEqual(
    (original.payload.resume as { readonly pendingTurnInputs: ReadonlyArray<unknown> })
      .pendingTurnInputs,
    [{ input: "never write this prompt to provider logs" }],
  );
});
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const piInstanceId = ProviderInstanceId.make("pi");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const PI_DRIVER = ProviderDriverKind.make("pi");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

it("restores only canonical provider options from attached-agent persistence", () => {
  assert.deepEqual(
    readPersistedAttachedAgentOptions([
      { id: " reasoningEffort ", value: " high " },
      { id: "fastMode", value: false },
      { id: "", value: "ignored" },
      { id: "context", value: 600_000 },
      null,
    ]),
    [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: false },
    ],
  );
  assert.equal(readPersistedAttachedAgentOptions({ effort: "medium" }), undefined);
});

it("restores an attached agent's exact model selection from legacy persistence", () => {
  assert.deepEqual(
    readPersistedModelSelection(
      {
        model: "openai-codex/gpt-5.1",
        attachedAgent: {
          model: "openai-codex/gpt-5.6-sol",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "contextWindow", value: "600k" },
          ],
        },
      },
      ProviderInstanceId.make("pi"),
    ),
    {
      instanceId: ProviderInstanceId.make("pi"),
      model: "openai-codex/gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "contextWindow", value: "600k" },
      ],
    },
  );
});

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const pi = makeFakeCodexAdapter(ProviderDriverKind.make("pi"));
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("pi")]: pi.adapter,
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    pi,
    codex,
    claude,
    cursor,
    layer,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("preserves a live running binding across graceful service shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const outerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(outerScope, Exit.void));
    const persistenceServices = yield* Layer.build(
      Layer.mergeAll(directoryLayer, runtimeRepositoryLayer, NodeServices.layer),
    ).pipe(Scope.provide(outerScope));

    const providerScope = yield* Scope.make();
    const providerServices = yield* Layer.build(
      makeProviderServiceLive({ restoreSessionsOnStart: false }).pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
    ).pipe(Effect.provide(persistenceServices), Scope.provide(providerScope));
    const provider = yield* ProviderService.ProviderService.pipe(Effect.provide(providerServices));
    const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository.pipe(
      Effect.provide(persistenceServices),
    );

    const threadId = asThreadId("thread-graceful-restart");
    const session = yield* provider.startSession(threadId, {
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      threadId,
      runtimeMode: "full-access",
    });
    const turn = yield* provider.sendTurn({
      threadId,
      input: "continue across restart",
      attachments: [],
    });
    codex.updateSession(threadId, (current) => ({
      ...current,
      status: "running",
      activeTurnId: turn.turnId,
    }));

    yield* Scope.close(providerScope, Exit.void);

    const persisted = yield* runtimeRepository.getByThreadId({ threadId });
    assert.equal(Option.isSome(persisted), true);
    if (Option.isSome(persisted)) {
      assert.equal(persisted.value.status, "running");
      assert.deepEqual(persisted.value.resumeCursor, session.resumeCursor);
      assert.equal(
        (persisted.value.runtimePayload as { activeTurnId?: string } | null)?.activeTurnId,
        turn.turnId,
      );
    }
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "starcode-provider-service-"),
    );
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * The restart story this exists for: the provider processes are driven over
 * this server's stdio, so restarting it kills every agent at once. Recovery
 * itself already worked, but its only trigger was an incoming command, so the
 * threads stayed dead until a human poked each one. Boot now does the poking.
 */
it.effect("ProviderServiceLive resumes running sessions on startup", () =>
  Effect.gen(function* () {
    const piDriver = ProviderDriverKind.make("pi");
    const piInstanceId = ProviderInstanceId.make("pi");
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "starcode-provider-restore-"),
    );
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const pi = makeFakeCodexAdapter(piDriver);
    const registry = makeAdapterRegistryMock({
      [piDriver]: pi.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      // Alive when the server died: must come back.
      yield* directory.upsert({
        provider: piDriver,
        providerInstanceId: piInstanceId,
        threadId: ThreadId.make("thread-running"),
        status: "running",
        resumeCursor: { opaque: "resume-thread-running" },
        runtimePayload: { activeTurnId: "turn-running-before-restart" },
      });
      // Deliberately stopped: must stay stopped.
      yield* directory.upsert({
        provider: piDriver,
        providerInstanceId: piInstanceId,
        threadId: ThreadId.make("thread-stopped"),
        status: "stopped",
        resumeCursor: { opaque: "resume-thread-stopped" },
      });
      // Never got far enough to persist a cursor: skipped, not failed.
      yield* directory.upsert({
        provider: piDriver,
        providerInstanceId: piInstanceId,
        threadId: ThreadId.make("thread-no-cursor"),
        status: "running",
      });
      // A pre-fix graceful shutdown rewrote this live runtime binding to
      // stopped even though its projected turn was still running. Startup
      // must resume exactly this narrow state.
      yield* directory.upsert({
        provider: piDriver,
        providerInstanceId: piInstanceId,
        threadId: ThreadId.make("thread-legacy-stranded"),
        status: "stopped",
        resumeCursor: { opaque: "resume-thread-legacy-stranded" },
        runtimePayload: { lastRuntimeEvent: "provider.stopAll" },
      });
      // The marker alone is not enough: an ordinary stopped thread with no
      // matching projected active turn must remain stopped.
      yield* directory.upsert({
        provider: piDriver,
        providerInstanceId: piInstanceId,
        threadId: ThreadId.make("thread-old-clean-stop"),
        status: "stopped",
        resumeCursor: { opaque: "resume-thread-old-clean-stop" },
        runtimePayload: { lastRuntimeEvent: "provider.stopAll" },
      });
    }).pipe(Effect.provide(directoryLayer));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        ) VALUES (
          'thread-legacy-stranded',
          'running',
          'pi',
          ${piInstanceId},
          NULL,
          NULL,
          'full-access',
          'turn-legacy-stranded',
          NULL,
          '2026-08-01T13:38:47.061Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        ) VALUES (
          'thread-legacy-stranded',
          'turn-legacy-stranded',
          NULL,
          NULL,
          'running',
          '2026-08-01T13:38:43.730Z',
          '2026-08-01T13:38:43.730Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;
    }).pipe(Effect.provide(persistenceLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      const recovery = readAttachedAgentStartupRecovery();
      assert.isDefined(recovery);
      yield* Effect.tryPromise(() => recovery!.awaitCompletion());
    }).pipe(Effect.provide(providerLayer));

    const resumed = pi.startSession.mock.calls.map(([input]) => String(input.threadId)).toSorted();
    assert.deepEqual(resumed, ["thread-legacy-stranded", "thread-running"]);
    const runningRecovery = pi.startSession.mock.calls.find(
      ([input]) => input.threadId === "thread-running",
    )?.[0];
    assert.equal(runningRecovery?.activeTurnId, "turn-running-before-restart");

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive retires legacy runtimes without invoking removed harnesses", () =>
  Effect.gen(function* () {
    const legacy = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({ [CODEX_DRIVER]: legacy.adapter });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const sharedScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(sharedScope, Exit.void));
    const sharedServices = yield* Layer.build(
      Layer.mergeAll(directoryLayer, runtimeRepositoryLayer, NodeServices.layer),
    ).pipe(Scope.provide(sharedScope));
    const topLevelThreadId = asThreadId("legacy-codex-top-level");
    const attachedThreadId = asThreadId("attached:legacy-codex-child");
    const parentThreadId = asThreadId("legacy-parent");
    const topLevelCursor = { threadId: "legacy-native-codex-thread" };
    const attachedCursor = { threadId: "legacy-native-codex-child" };
    const attachedPayload = {
      cwd: "/tmp/legacy",
      attachedAgent: {
        agentRunId: "agent:legacy-codex-child",
        parentThreadId,
        description: "Legacy Codex child",
        status: "running",
        startedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
        continuationPrompt: "must never be replayed",
      },
    };

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: topLevelThreadId,
        status: "running",
        resumeCursor: topLevelCursor,
        runtimePayload: { cwd: "/tmp/legacy", activeTurnId: "legacy-turn" },
      });
      yield* directory.upsert({
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: attachedThreadId,
        status: "starting",
        resumeCursor: attachedCursor,
        runtimePayload: attachedPayload,
      });
    }).pipe(Effect.provide(sharedServices));

    const providerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(providerScope, Exit.void));
    yield* Layer.build(
      makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
    ).pipe(Effect.provide(sharedServices), Scope.provide(providerScope));

    const recovery = readAttachedAgentStartupRecovery();
    assert.isDefined(recovery);
    const recovered = yield* Effect.tryPromise(() => recovery!.awaitCompletion());
    assert.deepEqual(recovered, []);
    assert.equal(legacy.startSession.mock.calls.length, 0);
    assert.deepEqual(requireAttachedAgentHost().status(parentThreadId), []);

    const [topLevel, attached] = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* Effect.all([
        directory.getBinding(topLevelThreadId),
        directory.getBinding(attachedThreadId),
      ]);
    }).pipe(Effect.provide(sharedServices));
    assert.equal(Option.isSome(topLevel), true);
    assert.equal(Option.isSome(attached), true);
    if (Option.isSome(topLevel)) {
      assert.equal(topLevel.value.status, "stopped");
      assert.deepEqual(topLevel.value.resumeCursor, topLevelCursor);
      assert.deepEqual(topLevel.value.runtimePayload, {
        cwd: "/tmp/legacy",
        activeTurnId: "legacy-turn",
      });
    }
    if (Option.isSome(attached)) {
      assert.equal(attached.value.status, "stopped");
      assert.deepEqual(attached.value.resumeCursor, attachedCursor);
      assert.deepEqual(attached.value.runtimePayload, attachedPayload);
    }
  }),
);

it.effect("ProviderServiceLive isolates disabled and missing attached Pi recovery", () =>
  Effect.gen(function* () {
    const pi = makeFakeCodexAdapter(ProviderDriverKind.make("pi"));
    const registryBase = makeAdapterRegistryMock({
      [ProviderDriverKind.make("pi")]: pi.adapter,
    });
    const disabledInstanceId = ProviderInstanceId.make("pi-disabled");
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getByInstance: (instanceId) =>
        instanceId === disabledInstanceId
          ? Effect.succeed(pi.adapter)
          : registryBase.getByInstance(instanceId),
      getInstanceInfo: (instanceId) =>
        instanceId === disabledInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: ProviderDriverKind.make("pi"),
              displayName: "Disabled Pi",
              enabled: false,
              continuationIdentity: {
                driverKind: ProviderDriverKind.make("pi"),
                continuationKey: "pi:disabled",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const sharedScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(sharedScope, Exit.void));
    const sharedServices = yield* Layer.build(
      Layer.mergeAll(directoryLayer, runtimeRepositoryLayer, NodeServices.layer),
    ).pipe(Scope.provide(sharedScope));
    const disabledThreadId = asThreadId("attached:disabled-pi-child");
    const missingThreadId = asThreadId("attached:missing-pi-child");

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      for (const [threadId, instanceId, agentRunId] of [
        [disabledThreadId, disabledInstanceId, "agent:disabled-pi-child"],
        [missingThreadId, ProviderInstanceId.make("pi-missing"), "agent:missing-pi-child"],
      ] as const) {
        yield* directory.upsert({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId,
          status: "running",
          resumeCursor: { sessionFile: "/tmp/missing.jsonl", sessionId: agentRunId },
          runtimePayload: {
            attachedAgent: {
              agentRunId,
              parentThreadId: "parent-recovery",
              description: agentRunId,
              status: "running",
              startedAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:01:00.000Z",
              continuationPrompt: "do not replay",
            },
          },
        });
      }
    }).pipe(Effect.provide(sharedServices));

    const providerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(providerScope, Exit.void));
    yield* Layer.build(
      makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
    ).pipe(Effect.provide(sharedServices), Scope.provide(providerScope));

    const recovery = readAttachedAgentStartupRecovery();
    assert.isDefined(recovery);
    assert.deepEqual(yield* Effect.tryPromise(() => recovery!.awaitCompletion()), []);
    const statuses = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* Effect.forEach([disabledThreadId, missingThreadId], (threadId) =>
        directory
          .getBinding(threadId)
          .pipe(Effect.map((binding) => Option.getOrThrow(binding).status)),
      );
    }).pipe(Effect.provide(sharedServices));
    assert.deepEqual(statuses, ["stopped", "stopped"]);
    assert.equal(pi.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps a timed-out startup restore recoverable", () =>
  Effect.gen(function* () {
    const piDriver = ProviderDriverKind.make("pi");
    const piInstanceId = ProviderInstanceId.make("pi");
    const pi = makeFakeCodexAdapter(piDriver);
    pi.startSession.mockImplementation(() => Effect.never);
    const registry = makeAdapterRegistryMock({
      [piDriver]: pi.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const sharedLayer = Layer.mergeAll(directoryLayer, runtimeRepositoryLayer, NodeServices.layer);
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const sharedServices = yield* Layer.build(sharedLayer).pipe(Scope.provide(scope));
    const threadId = asThreadId("thread-hung-startup-restore");

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: piDriver,
        providerInstanceId: piInstanceId,
        threadId,
        status: "running",
        resumeCursor: { opaque: "resume-hung-startup-restore" },
      });
    }).pipe(Effect.provide(sharedServices));

    const providerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(providerScope, Exit.void));
    yield* Layer.build(
      makeProviderServiceLive({
        sessionRecoveryTimeout: "50 millis",
        sessionRecoveryRetryDelay: "10 millis",
      }).pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
    ).pipe(Effect.provide(sharedServices), Scope.provide(providerScope));

    const recovery = readAttachedAgentStartupRecovery();
    assert.isDefined(recovery);
    const recoveryFiber = yield* Effect.tryPromise(() => recovery!.awaitCompletion()).pipe(
      Effect.forkChild,
    );
    for (let tick = 0; tick < 20; tick += 1) yield* Effect.yieldNow;
    yield* advanceTestClock(51);

    const binding = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getBinding(threadId);
    }).pipe(Effect.provide(sharedServices));
    assert.equal(Option.isSome(binding), true);
    if (Option.isSome(binding)) assert.equal(binding.value.status, "running");
    assert.equal(recoveryFiber.pollUnsafe(), undefined);
    assert.isAtLeast(pi.startSession.mock.calls.length, 1);
  }),
);

it.effect(
  "ProviderServiceLive retries delayed paused Pi recovery without replaying its prompt",
  () =>
    Effect.gen(function* () {
      const piDriver = ProviderDriverKind.make("pi");
      const piInstanceId = ProviderInstanceId.make("pi");
      const pi = makeFakeCodexAdapter(piDriver);
      const resumeCursor = {
        sessionFile: "/tmp/pi-paused-recovery.jsonl",
        sessionId: "pi-paused-provider-session",
        attached: {
          parentThreadId: "parent-delayed-pi-recovery",
          agentRunId: "agent:delayed-pi-recovery",
          depth: 1,
        },
      };
      let attempts = 0;
      pi.startSession.mockImplementation((input) => {
        attempts += 1;
        if (attempts === 1) return Effect.never;
        const now = "2026-08-01T00:00:00.000Z";
        return Effect.succeed({
          provider: piDriver,
          providerInstanceId: piInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor,
          cwd: input.cwd,
          model: input.modelSelection?.model,
          createdAt: now,
          updatedAt: now,
        } satisfies ProviderSession);
      });
      const registry = makeAdapterRegistryMock({ [piDriver]: pi.adapter });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const sharedLayer = Layer.mergeAll(
        directoryLayer,
        runtimeRepositoryLayer,
        NodeServices.layer,
      );
      const sharedScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(sharedScope, Exit.void));
      const sharedServices = yield* Layer.build(sharedLayer).pipe(Scope.provide(sharedScope));
      const virtualThreadId = asThreadId("attached:delayed-pi-recovery");
      const parentThreadId = asThreadId("parent-delayed-pi-recovery");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          provider: piDriver,
          providerInstanceId: piInstanceId,
          threadId: virtualThreadId,
          status: "running",
          resumeCursor,
          runtimePayload: {
            modelSelection: {
              instanceId: piInstanceId,
              model: "openai-codex/gpt-5.6-sol",
              options: [{ id: "effort", value: "high" }],
            },
            attachedAgent: {
              agentRunId: "agent:delayed-pi-recovery",
              parentThreadId,
              description: "Delayed paused Pi recovery",
              model: "openai-codex/gpt-5.6-sol",
              options: [{ id: "effort", value: "high" }],
              status: "paused",
              startedAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:01:00.000Z",
              continuationPrompt: "This completed prompt must not be replayed.",
            },
          },
        });
      }).pipe(Effect.provide(sharedServices));

      const providerScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(providerScope, Exit.void));
      yield* Layer.build(
        makeProviderServiceLive({
          sessionRecoveryTimeout: "50 millis",
          sessionRecoveryRetryDelay: "10 millis",
        }).pipe(
          Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
      ).pipe(Effect.provide(sharedServices), Scope.provide(providerScope));

      const recovery = readAttachedAgentStartupRecovery();
      assert.isDefined(recovery);
      const recoveryFiber = yield* Effect.tryPromise(() => recovery!.awaitCompletion()).pipe(
        Effect.forkChild,
      );
      for (let tick = 0; tick < 20; tick += 1) yield* Effect.yieldNow;
      yield* advanceTestClock(51);

      const timedOutBinding = yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        return yield* directory.getBinding(virtualThreadId);
      }).pipe(Effect.provide(sharedServices));
      assert.equal(Option.isSome(timedOutBinding), true);
      if (Option.isSome(timedOutBinding)) {
        assert.equal(timedOutBinding.value.status, "running");
        assert.deepEqual(timedOutBinding.value.resumeCursor, resumeCursor);
      }
      assert.equal(recoveryFiber.pollUnsafe(), undefined);

      yield* advanceTestClock(11);
      const recovered = yield* Fiber.join(recoveryFiber);
      assert.equal(pi.startSession.mock.calls.length, 2);
      assert.equal(pi.sendTurn.mock.calls.length, 0);
      assert.deepInclude(pi.startSession.mock.calls[1]?.[0], {
        threadId: virtualThreadId,
        providerInstanceId: piInstanceId,
        resumeCursor,
        modelSelection: {
          instanceId: piInstanceId,
          model: "openai-codex/gpt-5.6-sol",
          options: [{ id: "effort", value: "high" }],
        },
      });
      assert.lengthOf(recovered, 1);
      assert.equal(recovered[0]?.driver, piDriver);
      assert.equal(recovered[0]?.live, true);
      assert.deepInclude(recovered[0]?.snapshot, {
        agentRunId: "agent:delayed-pi-recovery",
        parentThreadId,
        providerInstanceId: piInstanceId,
        status: "paused",
      });
    }),
);

it.effect(
  "ProviderServiceLive does not recover a stale attached binding after its AgentRun completed",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "starcode-provider-attached-terminal-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

      const codex = makeFakeCodexAdapter();
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: codex.adapter,
      });
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const virtualThreadId = ThreadId.make("attached:terminal-child");
      const parentThreadId = ThreadId.make("parent-terminal-child");
      const agentRunId = "agent:terminal-child";

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId: virtualThreadId,
          status: "running",
          resumeCursor: { opaque: "resume-terminal-child" },
          runtimePayload: {
            attachedAgent: {
              agentRunId,
              parentThreadId,
              description: "already completed child",
              model: "openai/gpt-5.2",
              startedAt: "2026-08-01T10:00:00.000Z",
              continuationPrompt: "Return the exact requested token.",
            },
          },
        });
        yield* sql`
          INSERT INTO projection_agent_runs (
            parent_thread_id,
            provider,
            provider_instance_id,
            agent_run_id,
            parent_agent_run_id,
            launch_tool_use_id,
            task_type,
            agent_type,
            model,
            description,
            status,
            started_at,
            updated_at,
            history_session_id,
            transcript_state,
            parent_native_session_id
          ) VALUES (
            ${parentThreadId},
            'codex',
            ${codexInstanceId},
            ${agentRunId},
            NULL,
            ${agentRunId},
            'attached_agent',
            'codex agent',
            'openai/gpt-5.2',
            'already completed child',
            'completed',
            '2026-08-01T10:00:00.000Z',
            '2026-08-01T10:01:00.000Z',
            NULL,
            'unavailable',
            NULL
          )
        `;
      }).pipe(Effect.provide(Layer.merge(directoryLayer, persistenceLayer)));

      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* ProviderService.ProviderService;
        for (let tick = 0; tick < 100; tick += 1) yield* Effect.yieldNow;
      }).pipe(Effect.provide(providerLayer));

      assert.equal(codex.startSession.mock.calls.length, 0);
      const binding = yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        return yield* directory.getBinding(virtualThreadId);
      }).pipe(Effect.provide(directoryLayer));
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) assert.equal(binding.value.status, "stopped");

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "starcode-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstPi = makeFakeCodexAdapter(PI_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [PI_DRIVER]: firstPi.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: PI_DRIVER,
          providerInstanceId: piInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstPi.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterShutdown = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterShutdown), true);
      if (Option.isSome(persistedAfterShutdown)) {
        assert.equal(persistedAfterShutdown.value.status, "running");
        assert.deepEqual(persistedAfterShutdown.value.resumeCursor, updatedResumeCursor);
      }

      const secondPi = makeFakeCodexAdapter(PI_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [PI_DRIVER]: secondPi.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondPi.startSession.mockClear();
      secondPi.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondPi.startSession.mock.calls.length, 1);
      const resumedStartInput = secondPi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondPi.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondPi.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("cancels attached children before a missing parent session can reject stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const parentThreadId = asThreadId("thread-missing-parent-with-child");
      const host = requireAttachedAgentHost();
      const child = yield* Effect.tryPromise(() =>
        host.spawn({
          parentThreadId,
          cwd: "/tmp/project",
          providerInstanceId: ProviderInstanceId.make("pi"),
          prompt: "Wait for cancellation.",
          description: "active child during parent stop",
          depth: 0,
          maxDepth: 1,
          maxChildren: 1,
        }),
      );

      const stopResult = yield* Effect.result(provider.stopSession({ threadId: parentThreadId }));
      assert.equal(stopResult._tag, "Failure");
      assert.equal(host.status(parentThreadId, [child.agentRunId])[0]?.status, "stopped");
      assert.equal(routing.pi.stopSession.mock.calls.length, 1);
      routing.pi.startSession.mockClear();
      routing.pi.sendTurn.mockClear();
      routing.pi.interruptTurn.mockClear();
      routing.pi.stopSession.mockClear();
    }),
  );

  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "pi");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.pi.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.pi.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.pi.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.pi.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.pi.startSession.mockClear();
      routing.pi.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.pi.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.pi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.pi.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.pi.stopSession(initial.threadId);
      routing.pi.startSession.mockClear();
      routing.pi.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.pi.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.pi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.pi.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.pi.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.pi.startSession.mockClear();
      routing.pi.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.pi.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.pi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.pi.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("rejects replacement starts for a retired persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const failure = yield* Effect.flip(
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          cwd: "/tmp/project-provider-replacement",
          runtimeMode: "full-access",
        }),
      );

      assert.equal(codexSession.provider, "codex");
      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "bound to retired provider 'codex'");
      assert.equal(routing.codex.stopSession.mock.calls.length, 0);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["codex"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.pi.stopAll();
      routing.pi.startSession.mockClear();
      routing.pi.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.pi.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.pi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.pi.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale Pi sessions for sendTurn using persisted cwd and model", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-pi-send-turn"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-pi-send-turn"),
        cwd: "/tmp/project-pi-send-turn",
        modelSelection: createModelSelection(piInstanceId, "openai-codex/gpt-5.6-sol", [
          { id: "effort", value: "max" },
        ]),
        runtimeMode: "full-access",
      });

      yield* routing.pi.stopAll();
      routing.pi.startSession.mockClear();
      routing.pi.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with Pi",
        attachments: [],
      });

      assert.equal(routing.pi.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.pi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project-pi-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(piInstanceId, "openai-codex/gpt-5.6-sol", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.pi.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.pi.stopAll();
      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();
      yield* routing.cursor.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "starcode-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstPi = makeFakeCodexAdapter(PI_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [PI_DRIVER]: firstPi.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-pi-start"), {
          provider: PI_DRIVER,
          providerInstanceId: piInstanceId,
          threadId: asThreadId("thread-pi-start"),
          cwd: "/tmp/project-pi-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondPi = makeFakeCodexAdapter(PI_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [PI_DRIVER]: secondPi.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondPi.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: PI_DRIVER,
          providerInstanceId: piInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-pi-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondPi.startSession.mock.calls.length, 1);
      const resumedStartInput = secondPi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project-pi-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses persisted cwd when startSession resumes a Pi session without cwd input", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "starcode-provider-service-cwd-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstPi = makeFakeCodexAdapter(PI_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [PI_DRIVER]: firstPi.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-pi-cwd"), {
          provider: PI_DRIVER,
          providerInstanceId: piInstanceId,
          threadId: asThreadId("thread-pi-cwd"),
          cwd: "/tmp/project-pi-cwd",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      const secondPi = makeFakeCodexAdapter(PI_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [PI_DRIVER]: secondPi.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondPi.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: PI_DRIVER,
          providerInstanceId: piInstanceId,
          threadId: initial.threadId,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondPi.startSession.mock.calls.length, 1);
      const resumedStartInput = secondPi.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "pi");
        assert.equal(startPayload.cwd, "/tmp/project-pi-cwd");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-ordered"), {
        provider: PI_DRIVER,
        providerInstanceId: piInstanceId,
        threadId: asThreadId("thread-ordered"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: PI_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: PI_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: PI_DRIVER,
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.pi.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "starcode_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "starcode_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "starcode_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "starcode_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "starcode_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "starcode_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "starcode_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("rejects a retired imported binding without mutating its provenance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-legacy-import-read-only");
      const original = {
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: ProviderInstanceId.make("codex_personal"),
        status: "stopped" as const,
        runtimeMode: "full-access" as const,
        resumeCursor: { threadId: "native-codex-history" },
        runtimePayload: { cwd: "/tmp/legacy-import" },
      };
      yield* directory.upsert(original);
      const before = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(before), true);

      validation.pi.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          threadId,
          cwd: "/tmp/legacy-import",
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "openai-codex/gpt-5.6-sol",
          },
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "bound to retired provider 'codex'");
      assert.equal(validation.pi.startSession.mock.calls.length, 0);
      const after = yield* directory.getBinding(threadId);
      assert.deepEqual(after, before);

      const unknownThreadId = asThreadId("thread-unknown-removed-runtime");
      yield* directory.upsert({
        ...original,
        threadId: unknownThreadId,
        provider: ProviderDriverKind.make("future-removed-provider"),
        providerInstanceId: ProviderInstanceId.make("deleted-custom-instance"),
        status: "running",
      });
      const unknownBefore = yield* directory.getBinding(unknownThreadId);
      const unknownFailure = yield* Effect.flip(
        provider.startSession(unknownThreadId, {
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          threadId: unknownThreadId,
          cwd: "/tmp/legacy-import",
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "openai-codex/gpt-5.6-sol",
          },
        }),
      );
      assert.instanceOf(unknownFailure, ProviderValidationError);
      assert.include(unknownFailure.issue, "bound to retired provider 'future-removed-provider'");
      assert.deepEqual(yield* directory.getBinding(unknownThreadId), unknownBefore);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});
