// @effect-diagnostics globalDate:off globalTimers:off - Promise timers implement the Pi tool API.
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterError } from "./Errors.ts";
import type {
  AttachedAgentHostShape,
  AttachedAgentRecoveryRuntime,
  AttachedAgentSnapshot,
  SpawnAttachedAgentInput,
} from "./AttachedAgentHost.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import { canonicalizePiProviderOptions, readPiEffort } from "./pi/PiProviderOptions.ts";

interface AttachedAgentRuntime {
  snapshot: AttachedAgentSnapshot;
  readonly virtualThreadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly spawnOrder: number;
  readonly output: Array<string>;
  readonly waiters: Set<() => void>;
  readonly openItems: Map<string, Extract<ProviderRuntimeEvent, { readonly type: "item.started" }>>;
  terminalPublished: boolean;
  terminalFinalization?: Promise<void>;
  liveAfterRecovery: boolean;
}

export interface AttachedAgentCoordinatorDependencies {
  readonly resolveAdapter: (instanceId: ProviderInstanceId) => Promise<{
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly driver: ProviderDriverKind;
    readonly enabled: boolean;
  }>;
  readonly parentRuntimeMode: (
    parentThreadId: ThreadId,
  ) => Promise<ProviderSession["runtimeMode"] | undefined>;
  readonly publish: (event: ProviderRuntimeEvent) => Promise<void>;
  readonly persist: (
    runtime: AttachedAgentSnapshot & {
      readonly virtualThreadId: ThreadId;
      readonly driver: ProviderDriverKind;
      readonly continuationPrompt: string;
      readonly resumeCursor?: unknown;
    },
  ) => Promise<void>;
  readonly clearPersisted: (virtualThreadId: ThreadId) => Promise<void>;
  readonly prepareMcp: (
    parentThreadId: ThreadId,
    virtualThreadId: ThreadId,
    instanceId: ProviderInstanceId,
  ) => Promise<void>;
  readonly clearMcp: (virtualThreadId: ThreadId) => Promise<void>;
}

const turnSettled = (status: AttachedAgentSnapshot["status"]): boolean => status !== "running";
const sessionClosed = (status: AttachedAgentSnapshot["status"]): boolean => status === "stopped";
const countsAgainstConcurrencyLimit = (status: AttachedAgentSnapshot["status"]): boolean =>
  status !== "failed" && status !== "stopped";

const compareRuntimeOrder = (left: AttachedAgentRuntime, right: AttachedAgentRuntime): number =>
  left.snapshot.startedAt.localeCompare(right.snapshot.startedAt) ||
  left.snapshot.agentRunId.localeCompare(right.snapshot.agentRunId);
const eventId = (): EventId => EventId.make(NodeCrypto.randomUUID());
const nowIso = (): string => new Date().toISOString();

interface RecoveredConversationItem {
  readonly id: string;
  readonly itemType: "user_message" | "assistant_message";
  readonly output: string;
}

const recoveredConversationItems = (
  items: ReadonlyArray<unknown>,
): ReadonlyArray<RecoveredConversationItem> => {
  const recovered: RecoveredConversationItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : NodeCrypto.randomUUID();
    if (record.type === "userMessage" && Array.isArray(record.content)) {
      const output = record.content
        .flatMap((content) => {
          if (typeof content !== "object" || content === null) return [];
          const contentRecord = content as Record<string, unknown>;
          return contentRecord.type === "text" && typeof contentRecord.text === "string"
            ? [contentRecord.text]
            : [];
        })
        .join("\n")
        .trim();
      if (output.length > 0) recovered.push({ id, itemType: "user_message", output });
    }
    if (record.type === "agentMessage" && typeof record.text === "string") {
      const output = record.text.trim();
      if (output.length > 0) recovered.push({ id, itemType: "assistant_message", output });
    }
    if (record.type === "assistant_message" && typeof record.output === "string") {
      const output = record.output.trim();
      if (output.length > 0) recovered.push({ id, itemType: "assistant_message", output });
    }
  }
  return recovered;
};

const recoveredAssistantText = (items: ReadonlyArray<RecoveredConversationItem>) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.itemType === "assistant_message") return item.output;
  }
  return undefined;
};

export function createAttachedAgentCoordinator(deps: AttachedAgentCoordinatorDependencies): {
  readonly host: AttachedAgentHostShape;
  readonly handleRuntimeEvent: (event: ProviderRuntimeEvent) => Promise<boolean>;
  readonly findRequestRoute: (requestId: string) =>
    | {
        readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
        readonly virtualThreadId: ThreadId;
      }
    | undefined;
  readonly restore: (input: {
    readonly snapshot: AttachedAgentSnapshot;
    readonly virtualThreadId: ThreadId;
    readonly driver: ProviderDriverKind;
    readonly continuationPrompt: string;
  }) => Promise<void>;
  readonly resume: (virtualThreadId: ThreadId, signal?: AbortSignal) => Promise<void>;
  readonly awaitStartupRecovery: () => Promise<ReadonlyArray<AttachedAgentRecoveryRuntime>>;
  readonly completeStartupRecovery: () => void;
} {
  const byId = new Map<string, AttachedAgentRuntime>();
  const byVirtualThread = new Map<ThreadId, AttachedAgentRuntime>();
  const requestRoutes = new Map<
    string,
    {
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
      readonly virtualThreadId: ThreadId;
    }
  >();
  const continuationPrompts = new Map<ThreadId, string>();
  const seenEventIds = new Set<string>();
  let resolveStartupRecovery!: () => void;
  const startupRecoveryComplete = new Promise<void>((resolve) => {
    resolveStartupRecovery = resolve;
  });
  let startupRecoveryCompleted = false;
  let spawnOrder = 0;
  let lastSpawnStartedAtMs = 0;
  let spawnReservationTail = Promise.resolve();

  const reserveSpawnSlot = async <A>(reserve: () => A): Promise<A> => {
    const previous = spawnReservationTail;
    let release!: () => void;
    spawnReservationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return reserve();
    } finally {
      release();
    }
  };

  const requireOwned = (parentThreadId: ThreadId, agentRunId: string): AttachedAgentRuntime => {
    const runtime = byId.get(agentRunId);
    if (!runtime || runtime.snapshot.parentThreadId !== parentThreadId) {
      throw new Error(`Attached agent '${agentRunId}' does not belong to this Starcode task.`);
    }
    return runtime;
  };

  const publishTaskProgress = async (runtime: AttachedAgentRuntime, description: string) => {
    await deps.publish({
      eventId: eventId(),
      provider: runtime.driver,
      providerInstanceId: runtime.snapshot.providerInstanceId,
      threadId: runtime.snapshot.parentThreadId,
      createdAt: nowIso(),
      type: "task.progress",
      payload: {
        taskId: RuntimeTaskId.make(runtime.snapshot.agentRunId),
        parentToolUseId: runtime.snapshot.agentRunId,
        description,
        summary: `${runtime.snapshot.description} · ${description}`,
      },
    });
  };

  const finalizeOpenItems = async (
    runtime: AttachedAgentRuntime,
    status: "completed" | "failed" | "stopped",
  ) => {
    for (const started of runtime.openItems.values()) {
      await deps.publish({
        ...started,
        eventId: eventId(),
        threadId: runtime.snapshot.parentThreadId,
        createdAt: nowIso(),
        type: "item.completed",
        payload: {
          ...started.payload,
          status: status === "stopped" ? "stopped" : "failed",
          output:
            status === "stopped"
              ? "Tool stopped because the attached agent was cancelled before a terminal result was recorded."
              : "Tool ended without a terminal result before the attached agent finished.",
          parentToolUseId: runtime.snapshot.agentRunId,
        },
      });
    }
    runtime.openItems.clear();
  };

  const finish = async (
    runtime: AttachedAgentRuntime,
    status: "completed" | "failed" | "stopped",
    message?: string,
  ) => {
    if (runtime.terminalPublished) return;
    if (runtime.terminalFinalization) {
      await runtime.terminalFinalization;
      return;
    }
    const finalization = (async () => {
      await finalizeOpenItems(runtime, status);
      const result =
        message?.trim() ||
        runtime.output.join("").trim() ||
        (status === "completed"
          ? "Agent completed successfully without textual output."
          : status === "stopped"
            ? "Agent was cancelled."
            : "Agent failed without a provider error message.");
      const updatedAt = nowIso();
      runtime.snapshot = {
        ...runtime.snapshot,
        status,
        ...(status === "failed" ? { error: result } : { result }),
        updatedAt,
      };
      await deps.persist({
        ...runtime.snapshot,
        virtualThreadId: runtime.virtualThreadId,
        driver: runtime.driver,
        continuationPrompt: continuationPrompts.get(runtime.virtualThreadId) ?? "",
      });
      // Retire the durable provider binding before publishing the terminal
      // AgentRun. If event publication fails, the same terminal event can be
      // retried without leaving startup recovery able to revive the child.
      await deps.clearPersisted(runtime.virtualThreadId);
      await deps.publish({
        eventId: eventId(),
        provider: runtime.driver,
        providerInstanceId: runtime.snapshot.providerInstanceId,
        threadId: runtime.snapshot.parentThreadId,
        createdAt: updatedAt,
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(runtime.snapshot.agentRunId),
          parentToolUseId: runtime.snapshot.agentRunId,
          status,
          summary: result,
          toolUseId: runtime.snapshot.agentRunId,
        },
      });
      runtime.terminalPublished = true;
      for (const [requestId, route] of requestRoutes) {
        if (route.virtualThreadId === runtime.virtualThreadId) requestRoutes.delete(requestId);
      }
      await deps.clearMcp(runtime.virtualThreadId);
      for (const wake of runtime.waiters) wake();
      runtime.waiters.clear();
    })();
    runtime.terminalFinalization = finalization;
    try {
      await finalization;
    } finally {
      if (runtime.terminalFinalization === finalization) {
        delete runtime.terminalFinalization;
      }
    }
  };

  const settleTurn = async (
    runtime: AttachedAgentRuntime,
    status: "paused" | "failed",
    message?: string,
  ) => {
    if (runtime.terminalPublished || sessionClosed(runtime.snapshot.status)) return;
    if (status === "failed") {
      await finish(runtime, "failed", message);
      return;
    }
    await finalizeOpenItems(runtime, "completed");
    const result =
      message?.trim() ||
      runtime.output.join("").trim() ||
      "Agent turn completed successfully without textual output.";
    const updatedAt = nowIso();
    runtime.snapshot = {
      ...runtime.snapshot,
      status,
      result,
      updatedAt,
    };
    // The send-turn cursor contains an activeTurnId. Once Pi settles that
    // turn, persist the adapter's refreshed cursor so a server restart does
    // not mistake an intentionally paused child for an interrupted live turn.
    const currentSession = await Effect.runPromise(runtime.adapter.listSessions())
      .then((sessions) => sessions.find((session) => session.threadId === runtime.virtualThreadId))
      .catch(() => undefined);
    await deps.persist({
      ...runtime.snapshot,
      virtualThreadId: runtime.virtualThreadId,
      driver: runtime.driver,
      continuationPrompt: continuationPrompts.get(runtime.virtualThreadId) ?? "",
      ...(currentSession?.resumeCursor !== undefined
        ? { resumeCursor: currentSession.resumeCursor }
        : {}),
    });
    await deps.publish({
      eventId: eventId(),
      provider: runtime.driver,
      providerInstanceId: runtime.snapshot.providerInstanceId,
      threadId: runtime.snapshot.parentThreadId,
      createdAt: updatedAt,
      type: "task.updated",
      payload: {
        taskId: RuntimeTaskId.make(runtime.snapshot.agentRunId),
        parentToolUseId: runtime.snapshot.agentRunId,
        status: "paused",
        description: runtime.snapshot.description,
      },
    });
    for (const wake of runtime.waiters) wake();
    runtime.waiters.clear();
  };

  const host: AttachedAgentHostShape = {
    spawn: async (input: SpawnAttachedAgentInput) => {
      if (input.depth >= input.maxDepth) {
        throw new Error(`Attached-agent depth limit (${input.maxDepth}) reached.`);
      }
      const resolved = await deps.resolveAdapter(input.providerInstanceId);
      if (!resolved.enabled) {
        throw new Error(`Provider instance '${input.providerInstanceId}' is disabled.`);
      }
      if (resolved.driver !== "pi") {
        throw new Error(
          `Attached agents run exclusively through Pi; instance '${input.providerInstanceId}' uses the removed '${resolved.driver}' harness. Choose a Pi instance and a provider-qualified Pi model instead.`,
        );
      }
      const effectiveOptions = canonicalizePiProviderOptions(input.options);
      const effectivePiEffort = readPiEffort(effectiveOptions) ?? "medium";
      const { runtime, agentRunId, virtualThreadId, startedAt } = await reserveSpawnSlot(() => {
        const activeTaskAgents = [...byId.values()].filter(
          (candidate) =>
            candidate.snapshot.parentThreadId === input.parentThreadId &&
            countsAgainstConcurrencyLimit(candidate.snapshot.status),
        );
        if (activeTaskAgents.length >= input.maxChildren) {
          throw new Error(
            `Attached-agent per-task concurrency limit (${input.maxChildren}) reached. Wait for or cancel an existing AgentRun before spawning another.`,
          );
        }
        const agentRunId = `agent:${NodeCrypto.randomUUID()}`;
        const virtualThreadId = ThreadId.make(`attached:${NodeCrypto.randomUUID()}`);
        // Persist ordering in the timestamp itself so recovery does not depend
        // on the process-local insertion order. Concurrent reservations can
        // share a wall-clock millisecond, so advance monotonically when needed.
        lastSpawnStartedAtMs = Math.max(Date.now(), lastSpawnStartedAtMs + 1);
        const startedAt = new Date(lastSpawnStartedAtMs).toISOString();
        const runtime: AttachedAgentRuntime = {
          snapshot: {
            agentRunId,
            parentThreadId: input.parentThreadId,
            ...(input.parentAgentRunId ? { parentAgentRunId: input.parentAgentRunId } : {}),
            providerInstanceId: input.providerInstanceId,
            ...(input.model ? { model: input.model } : {}),
            ...(effectiveOptions ? { options: effectiveOptions } : {}),
            description: input.description,
            status: "running",
            startedAt,
            updatedAt: startedAt,
          },
          virtualThreadId,
          driver: resolved.driver,
          adapter: resolved.adapter,
          spawnOrder: spawnOrder++,
          output: [],
          waiters: new Set(),
          openItems: new Map(),
          terminalPublished: false,
          liveAfterRecovery: true,
        };
        byId.set(agentRunId, runtime);
        byVirtualThread.set(virtualThreadId, runtime);
        continuationPrompts.set(virtualThreadId, input.prompt);
        return { runtime, agentRunId, virtualThreadId, startedAt };
      });
      await deps.publish({
        eventId: eventId(),
        provider: resolved.driver,
        providerInstanceId: input.providerInstanceId,
        threadId: input.parentThreadId,
        createdAt: startedAt,
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(agentRunId),
          parentToolUseId: agentRunId,
          taskType: "attached_agent",
          description: input.description,
          subagentType: `${resolved.driver} agent${effectivePiEffort ? ` · ${effectivePiEffort} effort` : ""}`,
          toolUseId: agentRunId,
          ...(input.model ? { model: input.model } : {}),
          ...(effectiveOptions ? { options: effectiveOptions } : {}),
          providerInstanceId: input.providerInstanceId,
          providerDriver: resolved.driver,
          ...(input.parentAgentRunId ? { parentAgentRunId: input.parentAgentRunId } : {}),
        },
      });
      await publishTaskProgress(runtime, "Starting provider session");
      try {
        await deps.prepareMcp(input.parentThreadId, virtualThreadId, input.providerInstanceId);
        const runtimeMode =
          (await deps.parentRuntimeMode(input.parentThreadId)) ?? "approval-required";
        const session = await Effect.runPromise(
          resolved.adapter.startSession({
            threadId: virtualThreadId,
            provider: resolved.driver,
            providerInstanceId: input.providerInstanceId,
            cwd: input.cwd,
            runtimeMode,
            ...(input.model
              ? {
                  modelSelection: {
                    instanceId: input.providerInstanceId,
                    model: input.model,
                    ...(effectiveOptions ? { options: effectiveOptions } : {}),
                  },
                }
              : {}),
            ...(resolved.driver === "pi"
              ? {
                  resumeCursor: {
                    sessionFile: "",
                    sessionId: "",
                    attached: {
                      parentThreadId: input.parentThreadId,
                      agentRunId,
                      depth: input.depth + 1,
                    },
                  },
                }
              : {}),
          }),
        );
        await deps.persist({
          ...runtime.snapshot,
          virtualThreadId,
          driver: resolved.driver,
          continuationPrompt: input.prompt,
          ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        });
        await publishTaskProgress(runtime, "Provider session ready; prompt delivered");
        const turn = await Effect.runPromise(
          resolved.adapter.sendTurn({
            threadId: virtualThreadId,
            input: input.prompt,
            attachments: [],
            ...(input.model
              ? {
                  modelSelection: {
                    instanceId: input.providerInstanceId,
                    model: input.model,
                    ...(effectiveOptions ? { options: effectiveOptions } : {}),
                  },
                }
              : {}),
          }),
        );
        await deps.persist({
          ...runtime.snapshot,
          virtualThreadId,
          driver: resolved.driver,
          continuationPrompt: input.prompt,
          ...(turn.resumeCursor !== undefined
            ? { resumeCursor: turn.resumeCursor }
            : session.resumeCursor !== undefined
              ? { resumeCursor: session.resumeCursor }
              : {}),
        });
        return runtime.snapshot;
      } catch (cause) {
        await finish(runtime, "failed", cause instanceof Error ? cause.message : String(cause));
        return runtime.snapshot;
      }
    },
    sendMessage: async (parentThreadId, agentRunId, message, senderAgentRunId) => {
      const runtime = requireOwned(parentThreadId, agentRunId);
      const senderRuntime = senderAgentRunId
        ? requireOwned(parentThreadId, senderAgentRunId)
        : undefined;
      if (sessionClosed(runtime.snapshot.status) || runtime.snapshot.status === "failed")
        throw new Error(`Attached agent '${agentRunId}' session is closed.`);
      if (runtime.snapshot.status !== "running") {
        runtime.output.length = 0;
        runtime.terminalPublished = false;
        const updatedAt = nowIso();
        runtime.snapshot = { ...runtime.snapshot, status: "running", updatedAt };
        await deps.persist({
          ...runtime.snapshot,
          virtualThreadId: runtime.virtualThreadId,
          driver: runtime.driver,
          continuationPrompt: continuationPrompts.get(runtime.virtualThreadId) ?? "",
        });
        await deps.publish({
          eventId: eventId(),
          provider: runtime.driver,
          providerInstanceId: runtime.snapshot.providerInstanceId,
          threadId: runtime.snapshot.parentThreadId,
          createdAt: updatedAt,
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(runtime.snapshot.agentRunId),
            parentToolUseId: runtime.snapshot.agentRunId,
            status: "running",
            description: runtime.snapshot.description,
          },
        });
      }
      if (senderRuntime) {
        await publishTaskProgress(
          senderRuntime,
          `Message delivered to ${runtime.snapshot.description}: ${message.slice(0, 180)}`,
        );
      }
      await publishTaskProgress(
        runtime,
        senderRuntime
          ? `Message from ${senderRuntime.snapshot.description} delivered: ${message.slice(0, 180)}`
          : `Message from parent delivered: ${message.slice(0, 240)}`,
      );
      const attributedMessage = senderRuntime
        ? `[Message from attached agent ${senderRuntime.snapshot.agentRunId} (${senderRuntime.snapshot.description})]\n${message}`
        : message;
      const turn = await Effect.runPromise(
        runtime.adapter.sendTurn({
          threadId: runtime.virtualThreadId,
          input: attributedMessage,
          attachments: [],
          ...(runtime.snapshot.model
            ? {
                modelSelection: {
                  instanceId: runtime.snapshot.providerInstanceId,
                  model: runtime.snapshot.model,
                  ...(runtime.snapshot.options ? { options: runtime.snapshot.options } : {}),
                },
              }
            : {}),
        }),
      );
      runtime.snapshot = { ...runtime.snapshot, updatedAt: nowIso() };
      await deps.persist({
        ...runtime.snapshot,
        virtualThreadId: runtime.virtualThreadId,
        driver: runtime.driver,
        continuationPrompt: continuationPrompts.get(runtime.virtualThreadId) ?? "",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
      });
      return runtime.snapshot;
    },
    wait: async (parentThreadId, ids, timeoutMs) => {
      const selected = (
        ids ??
        [...byId.values()]
          .filter((runtime) => runtime.snapshot.parentThreadId === parentThreadId)
          .map((runtime) => runtime.snapshot.agentRunId)
      )
        .map((id) => requireOwned(parentThreadId, id))
        .sort(compareRuntimeOrder);
      if (
        selected.some((runtime) => turnSettled(runtime.snapshot.status)) ||
        selected.length === 0
      ) {
        return selected.map((runtime) => runtime.snapshot);
      }
      let wake!: () => void;
      await Promise.race([
        new Promise<void>((resolve) => {
          wake = resolve;
          for (const runtime of selected) runtime.waiters.add(wake);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs ?? 30_000)),
      ]);
      for (const runtime of selected) runtime.waiters.delete(wake);
      return selected.map((runtime) => runtime.snapshot);
    },
    status: (parentThreadId, ids) => {
      const wanted = ids ? new Set(ids) : undefined;
      return [...byId.values()]
        .filter(
          (runtime) =>
            runtime.snapshot.parentThreadId === parentThreadId &&
            (!wanted || wanted.has(runtime.snapshot.agentRunId)),
        )
        .sort(compareRuntimeOrder)
        .map((runtime) => runtime.snapshot);
    },
    cancel: async (parentThreadId, agentRunId) => {
      const runtime = requireOwned(parentThreadId, agentRunId);
      if (!sessionClosed(runtime.snapshot.status)) {
        await publishTaskProgress(runtime, "Cancellation requested");
        await Effect.runPromise(runtime.adapter.interruptTurn(runtime.virtualThreadId)).catch(
          () => undefined,
        );
        await Effect.runPromise(runtime.adapter.stopSession(runtime.virtualThreadId)).catch(
          () => undefined,
        );
        await finish(runtime, "stopped", "Agent cancelled by its parent.");
      }
      return runtime.snapshot;
    },
    interruptTurn: async (parentThreadId, agentRunId) => {
      const runtime = requireOwned(parentThreadId, agentRunId);
      if (runtime.snapshot.status === "running") {
        await publishTaskProgress(runtime, "Turn interruption requested");
        await Effect.runPromise(runtime.adapter.interruptTurn(runtime.virtualThreadId));
      }
      return runtime.snapshot;
    },
    cancelParent: async (parentThreadId) => {
      const running = [...byId.values()].filter(
        (runtime) =>
          runtime.snapshot.parentThreadId === parentThreadId &&
          !sessionClosed(runtime.snapshot.status),
      );
      await Promise.all(
        running.map((runtime) => host.cancel(parentThreadId, runtime.snapshot.agentRunId)),
      );
    },
  };

  const handleRuntimeEvent = async (event: ProviderRuntimeEvent): Promise<boolean> => {
    const runtime = byVirtualThread.get(event.threadId);
    if (!runtime) return false;
    if (seenEventIds.has(String(event.eventId))) return true;
    seenEventIds.add(String(event.eventId));
    if (seenEventIds.size > 10_000) seenEventIds.clear();
    const parentToolUseId = runtime.snapshot.agentRunId;
    if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
      runtime.output.push(event.payload.delta);
    }
    if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
      if (
        runtime.output.length === 0 &&
        event.payload.output &&
        event.payload.output !== "Pi completed without textual output."
      )
        runtime.output.push(event.payload.output);
    }
    if (event.type === "runtime.error") {
      await deps.publish({
        ...event,
        threadId: runtime.snapshot.parentThreadId,
        payload: { ...event.payload, parentToolUseId },
      });
      await finish(runtime, "failed", event.payload.message);
      return true;
    }
    if (event.type === "turn.completed") {
      await settleTurn(
        runtime,
        event.payload.state === "failed" ? "failed" : "paused",
        event.payload.errorMessage,
      );
      return true;
    }
    if (
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
    ) {
      if (event.type === "item.started") {
        runtime.openItems.set(String(event.itemId), event);
      } else if (event.type === "item.completed") {
        runtime.openItems.delete(String(event.itemId));
      }
      await deps.publish({
        ...event,
        threadId: runtime.snapshot.parentThreadId,
        payload: { ...event.payload, parentToolUseId },
      });
      if (event.type !== "item.started") {
        const detail = event.payload.output || event.payload.detail || event.payload.title;
        await publishTaskProgress(
          runtime,
          detail?.trim() ||
            `${event.payload.itemType} ${event.type === "item.completed" ? "completed" : "updated"}`,
        );
      }
      return true;
    }
    if (event.type === "content.delta") {
      await deps.publish({
        ...event,
        threadId: runtime.snapshot.parentThreadId,
        payload: { ...event.payload, parentToolUseId },
      });
      return true;
    }
    if (event.type === "request.opened" || event.type === "request.resolved") {
      if (event.type === "request.opened") {
        requestRoutes.set(String(event.requestId), {
          adapter: runtime.adapter,
          virtualThreadId: runtime.virtualThreadId,
        });
      }
      await deps.publish({
        ...event,
        threadId: runtime.snapshot.parentThreadId,
        payload: { ...event.payload, parentToolUseId },
      });
      if (event.type === "request.resolved") requestRoutes.delete(String(event.requestId));
      return true;
    }
    if (event.type === "user-input.requested") {
      await deps.publish({
        ...event,
        threadId: runtime.snapshot.parentThreadId,
        payload: { ...event.payload, parentToolUseId },
      });
      return true;
    }
    if (event.type === "user-input.resolved") {
      await deps.publish({
        ...event,
        threadId: runtime.snapshot.parentThreadId,
        payload: { ...event.payload, parentToolUseId },
      });
      return true;
    }
    if (event.type === "thread.token-usage.updated") {
      await deps.publish({
        eventId: event.eventId,
        provider: runtime.driver,
        providerInstanceId: runtime.snapshot.providerInstanceId,
        threadId: runtime.snapshot.parentThreadId,
        createdAt: event.createdAt,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(runtime.snapshot.agentRunId),
          parentToolUseId: runtime.snapshot.agentRunId,
          description: "Usage updated",
          summary: `${runtime.snapshot.description} · usage updated`,
          usage: event.payload.usage,
        },
      });
      return true;
    }
    return true;
  };

  return {
    host,
    handleRuntimeEvent,
    findRequestRoute: (requestId) => requestRoutes.get(requestId),
    restore: async (input) => {
      if (byId.has(input.snapshot.agentRunId)) return;
      if (input.driver !== "pi") {
        throw new Error(
          `Cannot restore attached agent '${input.snapshot.agentRunId}': the persisted '${input.driver}' harness is retired.`,
        );
      }
      const resolved = await deps.resolveAdapter(input.snapshot.providerInstanceId);
      if (resolved.driver !== "pi") {
        throw new Error(
          `Cannot restore attached agent '${input.snapshot.agentRunId}': instance '${input.snapshot.providerInstanceId}' uses the retired '${resolved.driver}' harness.`,
        );
      }
      if (!resolved.enabled) {
        throw new Error(
          `Cannot restore attached agent '${input.snapshot.agentRunId}': Pi instance '${input.snapshot.providerInstanceId}' is disabled.`,
        );
      }
      const restoredStartedAtMs = Date.parse(input.snapshot.startedAt);
      if (Number.isFinite(restoredStartedAtMs)) {
        lastSpawnStartedAtMs = Math.max(lastSpawnStartedAtMs, restoredStartedAtMs);
      }
      const runtime: AttachedAgentRuntime = {
        snapshot: input.snapshot,
        virtualThreadId: input.virtualThreadId,
        driver: input.driver,
        adapter: resolved.adapter,
        spawnOrder: spawnOrder++,
        output: [],
        waiters: new Set(),
        openItems: new Map(),
        terminalPublished: false,
        liveAfterRecovery: false,
      };
      byId.set(input.snapshot.agentRunId, runtime);
      byVirtualThread.set(input.virtualThreadId, runtime);
      continuationPrompts.set(input.virtualThreadId, input.continuationPrompt);
    },
    resume: async (virtualThreadId, _signal) => {
      const runtime = byVirtualThread.get(virtualThreadId);
      if (
        !runtime ||
        sessionClosed(runtime.snapshot.status) ||
        runtime.snapshot.status === "failed"
      )
        return;
      if (runtime.snapshot.status === "paused" || runtime.snapshot.status === "completed") {
        runtime.liveAfterRecovery = true;
        return;
      }
      // The adapter has already resumed the durable provider session (including
      // any active Pi turn) before coordinator recovery reaches this point.
      // Re-sending the original assignment would create a second turn and can
      // race the provider's own continuation.
      runtime.liveAfterRecovery = true;

      const sessions = await Effect.runPromise(runtime.adapter.listSessions());
      const session = sessions.find((candidate) => candidate.threadId === virtualThreadId);
      if (session?.status === "ready") {
        const recoveredItems = await Effect.runPromise(runtime.adapter.readThread(virtualThreadId))
          .then((thread) => {
            for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
              const items = recoveredConversationItems(thread.turns[index]?.items ?? []);
              if (items.length > 0) return items;
            }
            return [];
          })
          .catch(() => []);
        for (const item of recoveredItems) {
          await deps.publish({
            eventId: eventId(),
            provider: runtime.driver,
            providerInstanceId: runtime.snapshot.providerInstanceId,
            threadId: runtime.snapshot.parentThreadId,
            createdAt: nowIso(),
            type: "item.completed",
            itemId: RuntimeItemId.make(item.id),
            payload: {
              itemType: item.itemType,
              status: "completed",
              title: item.itemType === "user_message" ? "You" : "Agent response",
              output: item.output,
              parentToolUseId: runtime.snapshot.agentRunId,
            },
          });
        }
        await settleTurn(
          runtime,
          "paused",
          recoveredAssistantText(recoveredItems) ??
            runtime.snapshot.result ??
            "Recovered provider turn is no longer running.",
        );
        return;
      }
      await publishTaskProgress(runtime, "Recovered provider session after server restart");
    },
    awaitStartupRecovery: async () => {
      await startupRecoveryComplete;
      return [...byId.values()].map((runtime) => ({
        snapshot: runtime.snapshot,
        driver: runtime.driver,
        live: runtime.liveAfterRecovery && !sessionClosed(runtime.snapshot.status),
      }));
    },
    completeStartupRecovery: () => {
      if (startupRecoveryCompleted) return;
      startupRecoveryCompleted = true;
      resolveStartupRecovery();
    },
  };
}
