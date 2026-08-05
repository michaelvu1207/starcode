// @effect-diagnostics globalDate:off - deterministic test fixtures use wire timestamps.
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderOptionSelections,
  type ProviderSession,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import type { ProviderAdapterError } from "./Errors.ts";
import { createAttachedAgentCoordinator } from "./AttachedAgentCoordinator.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";

const parent = ThreadId.make("parent-task");
const otherParent = ThreadId.make("other-task");
const cwd = "/tmp/project";

function fakeAdapter(driver: string) {
  const sent: Array<{
    threadId: string;
    input?: string;
    modelSelection?: {
      instanceId: string;
      model: string;
      options?: ProviderOptionSelections;
    };
  }> = [];
  const started: Array<{
    threadId: string;
    modelSelection?: {
      instanceId: string;
      model: string;
      options?: ProviderOptionSelections;
    };
  }> = [];
  const stopped: string[] = [];
  const interrupted: string[] = [];
  const sessions: ProviderSession[] = [];
  const threadItems: unknown[] = [];
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: ProviderDriverKind.make(driver),
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      Effect.sync(() => {
        started.push({
          threadId: input.threadId,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        });
        return {
          provider: ProviderDriverKind.make(driver),
          providerInstanceId: input.providerInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: { session: input.threadId },
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
      }),
    sendTurn: (input) => {
      sent.push({
        threadId: input.threadId,
        ...(input.input ? { input: input.input } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      });
      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${sent.length}`),
        resumeCursor: { activeTurnId: `turn-${sent.length}` },
      });
    },
    interruptTurn: (threadId) => Effect.sync(() => void interrupted.push(threadId)),
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: (threadId) => Effect.sync(() => void stopped.push(threadId)),
    listSessions: () => Effect.succeed(sessions),
    hasSession: () => Effect.succeed(true),
    readThread: (threadId) =>
      Effect.succeed({
        threadId,
        turns: [{ id: TurnId.make("recovered-turn"), items: threadItems }],
      }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
  return { adapter, sent, started, stopped, interrupted, sessions, threadItems };
}

function harness(options?: {
  readonly failTerminalPersistOnce?: boolean;
  readonly failTerminalPublishOnce?: boolean;
}) {
  const pi = fakeAdapter("pi");
  const codex = fakeAdapter("codex");
  const claude = fakeAdapter("claudeAgent");
  const byInstance = new Map([
    ["pi", pi],
    ["codex", codex],
    ["claude", claude],
  ]);
  const published: ProviderRuntimeEvent[] = [];
  const persisted: unknown[] = [];
  const cleared: string[] = [];
  let terminalPersistFailures = options?.failTerminalPersistOnce ? 1 : 0;
  let terminalPublishFailures = options?.failTerminalPublishOnce ? 1 : 0;
  const coordinator = createAttachedAgentCoordinator({
    resolveAdapter: async (instanceId) => {
      const entry = byInstance.get(instanceId);
      if (!entry) throw new Error("missing provider");
      return { adapter: entry.adapter, driver: entry.adapter.provider, enabled: true };
    },
    parentRuntimeMode: async () => "full-access",
    publish: async (event) => {
      if (terminalPublishFailures > 0 && event.type === "task.completed") {
        terminalPublishFailures -= 1;
        throw new Error("terminal publication unavailable");
      }
      published.push(event);
    },
    persist: async (runtime) => {
      if (
        terminalPersistFailures > 0 &&
        (runtime.status === "completed" ||
          runtime.status === "failed" ||
          runtime.status === "stopped")
      ) {
        terminalPersistFailures -= 1;
        throw new Error("terminal persistence unavailable");
      }
      persisted.push(runtime);
    },
    clearPersisted: async (threadId) => void cleared.push(threadId),
    prepareMcp: async () => undefined,
    clearMcp: async () => undefined,
  });
  return { coordinator, pi, codex, claude, published, persisted, cleared };
}

const spawnInput = (instance = "pi", overrides: Record<string, unknown> = {}) => ({
  parentThreadId: parent,
  cwd,
  providerInstanceId: ProviderInstanceId.make(instance),
  prompt: `Work using ${instance}`,
  description: `${instance} child`,
  depth: 0,
  maxDepth: 3,
  maxChildren: 4,
  ...overrides,
});

let nextEventId = 0;
function childEvent(
  snapshot: Awaited<ReturnType<ReturnType<typeof harness>["coordinator"]["host"]["spawn"]>>,
  virtualThreadId: ThreadId,
  event: Partial<ProviderRuntimeEvent> & Pick<ProviderRuntimeEvent, "type" | "payload">,
): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(`event-${nextEventId++}`),
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId: snapshot.providerInstanceId,
    threadId: virtualThreadId,
    createdAt: new Date().toISOString(),
    ...event,
  } as ProviderRuntimeEvent;
}

describe("AttachedAgentCoordinator", () => {
  it("canonicalizes Pi effort and context before launch, persistence, and display", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(
      spawnInput("pi", {
        model: "openai-codex/gpt-5.6-sol",
        options: [
          { id: "context", value: "1m" },
          { id: "reasoningEffort", value: "high" },
        ],
      }),
    );
    const canonicalSelection = {
      instanceId: "pi",
      model: "openai-codex/gpt-5.6-sol",
      options: [
        { id: "effort", value: "high" },
        { id: "context", value: "1m" },
      ],
    };
    expect(child.options).toEqual(canonicalSelection.options);
    expect(h.pi.started[0]?.modelSelection).toEqual(canonicalSelection);
    expect(h.pi.sent[0]?.modelSelection).toEqual(canonicalSelection);
    expect(h.persisted[0]).toEqual(
      expect.objectContaining({
        providerInstanceId: "pi",
        model: "openai-codex/gpt-5.6-sol",
        options: canonicalSelection.options,
      }),
    );
    const started = h.published.find((event) => event.type === "task.started");
    expect(started?.type === "task.started" && started.payload.subagentType).toBe(
      "pi agent · high effort",
    );
    expect(started?.type === "task.started" && started.payload.options).toEqual(
      canonicalSelection.options,
    );
    expect(started?.type === "task.started" && started.payload.parentToolUseId).toBe(
      child.agentRunId,
    );
  });

  it("rejects unsupported Pi options before creating an AgentRun", async () => {
    const h = harness();
    await expect(
      h.coordinator.host.spawn(
        spawnInput("pi", {
          model: "openai-codex/gpt-5.6-sol",
          options: [{ id: "unknown", value: "high" }],
        }),
      ),
    ).rejects.toThrow("Unsupported Pi provider option 'unknown'");
    expect(h.pi.started).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });

  it("keeps one Pi child in the parent task and delivers a tangible attributed result", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    const started = h.published.find((event) => event.type === "task.started");
    expect(started?.threadId).toBe(parent);
    expect(started?.type === "task.started" && started.payload.providerDriver).toBe("pi");

    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "item.completed",
        itemId: RuntimeItemId.make("tool-calling-message"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Pi response",
          output: "Pi completed without textual output.",
        },
      }),
    );

    const item = childEvent(child, persisted.virtualThreadId, {
      type: "item.completed",
      itemId: RuntimeItemId.make("answer"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Pi response",
        output: "child result",
      },
    });
    await h.coordinator.handleRuntimeEvent(item);
    await h.coordinator.handleRuntimeEvent(item); // provider replay must deduplicate
    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "turn.completed",
        turnId: TurnId.make("turn-1"),
        payload: { state: "completed" },
      }),
    );

    const mapped = h.published.filter(
      (event) => event.type === "item.completed" && event.itemId === "answer",
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.threadId).toBe(parent);
    expect(mapped[0]?.type === "item.completed" && mapped[0].payload.parentToolUseId).toBe(
      child.agentRunId,
    );
    expect(h.coordinator.host.status(parent, [child.agentRunId])[0]).toMatchObject({
      status: "paused",
      result: "child result",
    });
    const settled = h.published.find(
      (event) => event.type === "task.updated" && event.payload.status === "paused",
    );
    expect(settled?.type === "task.updated" && settled.payload.parentToolUseId).toBe(
      child.agentRunId,
    );
  });

  it("closes every visible child item before publishing the terminal AgentRun", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    const itemId = RuntimeItemId.make("dangling-tool");

    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "item.started",
        turnId: TurnId.make("turn-with-dangling-tool"),
        itemId,
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "bash",
          detail: "run audit",
          data: { toolName: "bash", input: { command: "run audit" } },
        },
      }),
    );
    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "turn.completed",
        turnId: TurnId.make("turn-with-dangling-tool"),
        payload: { state: "completed" },
      }),
    );

    const terminalItemIndex = h.published.findIndex(
      (event) => event.type === "item.completed" && event.itemId === itemId,
    );
    const terminalTaskIndex = h.published.findIndex(
      (event) => event.type === "task.updated" && event.payload.status === "paused",
    );
    expect(terminalItemIndex).toBeGreaterThanOrEqual(0);
    expect(terminalTaskIndex).toBeGreaterThan(terminalItemIndex);
    const terminalItem = h.published[terminalItemIndex];
    expect(terminalItem).toMatchObject({
      type: "item.completed",
      payload: {
        status: "failed",
        parentToolUseId: child.agentRunId,
      },
    });
    expect(
      terminalItem?.type === "item.completed" ? terminalItem.payload.output : undefined,
    ).toMatch(/without a terminal result/i);
  });

  it("retries terminal finalization when durable persistence fails", async () => {
    const h = harness({ failTerminalPersistOnce: true });
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };

    await expect(
      h.coordinator.handleRuntimeEvent(
        childEvent(child, persisted.virtualThreadId, {
          type: "runtime.error",
          payload: { message: "provider failed" },
        }),
      ),
    ).rejects.toThrow("terminal persistence unavailable");
    expect(h.published.filter((event) => event.type === "task.completed")).toHaveLength(0);
    expect(h.cleared).toHaveLength(0);

    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "runtime.error",
        payload: { message: "provider failed" },
      }),
    );

    expect(h.published.filter((event) => event.type === "task.completed")).toHaveLength(1);
    expect(h.cleared).toEqual([persisted.virtualThreadId]);
  });

  it("retries terminal finalization when terminal publication fails", async () => {
    const h = harness({ failTerminalPublishOnce: true });
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };

    await expect(
      h.coordinator.handleRuntimeEvent(
        childEvent(child, persisted.virtualThreadId, {
          type: "runtime.error",
          payload: { message: "provider failed" },
        }),
      ),
    ).rejects.toThrow("terminal publication unavailable");
    expect(h.published.filter((event) => event.type === "task.completed")).toHaveLength(0);

    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "runtime.error",
        payload: { message: "provider failed" },
      }),
    );

    expect(h.published.filter((event) => event.type === "task.completed")).toHaveLength(1);
    expect(h.cleared).toEqual([persisted.virtualThreadId, persisted.virtualThreadId]);
  });

  it("runs several Pi children with heterogeneous model providers in deterministic order", async () => {
    const h = harness();
    const children = await Promise.all([
      h.coordinator.host.spawn(
        spawnInput("pi", {
          model: "openai-codex/gpt-5.6-sol",
          options: [{ id: "effort", value: "high" }],
        }),
      ),
      h.coordinator.host.spawn(
        spawnInput("pi", {
          model: "anthropic/claude-opus-5",
          options: [
            { id: "effort", value: "medium" },
            { id: "context", value: "600k" },
          ],
        }),
      ),
      h.coordinator.host.spawn(
        spawnInput("pi", {
          model: "anthropic/claude-fable-5",
          options: [{ id: "effort", value: "high" }],
        }),
      ),
    ]);
    expect(h.coordinator.host.status(parent).map((child) => child.agentRunId)).toEqual(
      children.map((child) => child.agentRunId),
    );
    expect(h.pi.started.map((entry) => entry.modelSelection?.model)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-opus-5",
      "anthropic/claude-fable-5",
    ]);
    expect(h.pi.sent).toHaveLength(3);
    expect(h.codex.started).toHaveLength(0);
    expect(h.claude.started).toHaveLength(0);
    const starts = h.published.filter((event) => event.type === "task.started");
    expect(starts.map((event) => event.provider)).toEqual(["pi", "pi", "pi"]);
  });

  it("rejects removed Claude and Codex harness instances before creating lifecycle state", async () => {
    const h = harness();

    for (const instanceId of ["codex", "claude"] as const) {
      await expect(h.coordinator.host.spawn(spawnInput(instanceId))).rejects.toThrow(
        "Attached agents run exclusively through Pi",
      );
    }

    expect(h.coordinator.host.status(parent)).toHaveLength(0);
    expect(h.codex.started).toHaveLength(0);
    expect(h.codex.sent).toHaveLength(0);
    expect(h.claude.started).toHaveLength(0);
    expect(h.claude.sent).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });

  it("rejects a persisted non-Pi child before restoring coordinator lifecycle state", async () => {
    const h = harness();

    await expect(
      h.coordinator.restore({
        snapshot: {
          agentRunId: "agent:legacy-codex",
          parentThreadId: parent,
          providerInstanceId: ProviderInstanceId.make("codex"),
          description: "legacy Codex child",
          status: "running",
          startedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:01:00.000Z",
        },
        virtualThreadId: ThreadId.make("attached:legacy-codex"),
        driver: ProviderDriverKind.make("codex"),
        continuationPrompt: "must never be replayed",
      }),
    ).rejects.toThrow("persisted 'codex' harness is retired");

    expect(h.coordinator.host.status(parent)).toHaveLength(0);
    expect(h.codex.started).toHaveLength(0);
    expect(h.codex.sent).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });

  it("orders parent messages, wakes waiters, and prevents cross-task messaging", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    await h.coordinator.host.sendMessage(parent, child.agentRunId, "first");
    await h.coordinator.host.sendMessage(parent, child.agentRunId, "second");
    expect(h.pi.sent.map((turn) => turn.input)).toEqual(["Work using pi", "first", "second"]);
    await expect(
      h.coordinator.host.sendMessage(otherParent, child.agentRunId, "cross-talk"),
    ).rejects.toThrow("does not belong");

    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    const waiting = h.coordinator.host.wait(parent, [child.agentRunId], 5_000);
    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "turn.completed",
        turnId: TurnId.make("done"),
        payload: { state: "completed" },
      }),
    );
    await expect(waiting).resolves.toEqual([
      expect.objectContaining({ agentRunId: child.agentRunId, status: "paused" }),
    ]);
  });

  it("continues a paused Pi AgentRun in the same provider session", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "turn.completed",
        turnId: TurnId.make("initial-turn"),
        payload: { state: "completed" },
      }),
    );
    expect(h.coordinator.host.status(parent, [child.agentRunId])[0]?.status).toBe("paused");

    await h.coordinator.host.sendMessage(parent, child.agentRunId, "follow-up");

    expect(h.pi.started).toHaveLength(1);
    expect(h.pi.sent.map((turn) => turn.input)).toEqual(["Work using pi", "follow-up"]);
    expect(h.coordinator.host.status(parent, [child.agentRunId])[0]?.status).toBe("running");
    expect(h.persisted.at(-1)).toEqual(
      expect.objectContaining({ resumeCursor: { activeTurnId: "turn-2" } }),
    );
    expect(
      h.published.some(
        (event) => event.type === "task.updated" && event.payload.status === "running",
      ),
    ).toBe(true);
  });

  it("persists Pi's settled cursor when an AgentRun pauses", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    h.pi.sessions.push({
      provider: ProviderDriverKind.make("pi"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      status: "ready",
      runtimeMode: "full-access",
      threadId: persisted.virtualThreadId,
      resumeCursor: {
        sessionFile: "/tmp/pi-settled.jsonl",
        sessionId: "pi-settled",
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
    });

    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "turn.completed",
        turnId: TurnId.make("settled-turn"),
        payload: { state: "interrupted" },
      }),
    );

    expect(h.persisted.at(-1)).toEqual(
      expect.objectContaining({
        status: "paused",
        resumeCursor: {
          sessionFile: "/tmp/pi-settled.jsonl",
          sessionId: "pi-settled",
        },
      }),
    );
  });

  it("attributes agent-to-agent messages in both child lifecycles", async () => {
    const h = harness();
    const sender = await h.coordinator.host.spawn(
      spawnInput("pi", { description: "sender child" }),
    );
    const destination = await h.coordinator.host.spawn(
      spawnInput("pi", { description: "destination child" }),
    );

    await h.coordinator.host.sendMessage(
      parent,
      destination.agentRunId,
      "compare your findings",
      sender.agentRunId,
    );

    expect(h.pi.sent.at(-1)?.input).toContain(
      `[Message from attached agent ${sender.agentRunId} (sender child)]`,
    );
    const messageProgress = h.published.filter(
      (event) =>
        event.type === "task.progress" &&
        (event.payload.description.startsWith("Message delivered") ||
          event.payload.description.startsWith("Message from")),
    );
    expect(
      messageProgress.map((event) =>
        event.type === "task.progress" ? event.payload.parentToolUseId : undefined,
      ),
    ).toEqual([sender.agentRunId, destination.agentRunId]);
  });

  it("interrupts a turn without closing the attached Pi session", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    await h.coordinator.host.interruptTurn(parent, child.agentRunId);
    expect(h.pi.interrupted).toEqual([persisted.virtualThreadId]);
    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "turn.completed",
        turnId: TurnId.make("interrupted-turn"),
        payload: { state: "interrupted" },
      }),
    );
    expect(h.coordinator.host.status(parent, [child.agentRunId])[0]?.status).toBe("paused");
    expect(h.cleared).toHaveLength(0);
  });

  it("does not let a late turn completion reopen an explicitly stopped child", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    await h.coordinator.host.cancel(parent, child.agentRunId);
    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "turn.completed",
        turnId: TurnId.make("late-turn"),
        payload: { state: "completed" },
      }),
    );
    expect(h.coordinator.host.status(parent, [child.agentRunId])[0]?.status).toBe("stopped");
  });

  it("removes child approval routing when the attached session is cancelled", async () => {
    const h = harness();
    const child = await h.coordinator.host.spawn(spawnInput());
    const persisted = h.persisted[0] as { virtualThreadId: ThreadId };
    await h.coordinator.handleRuntimeEvent(
      childEvent(child, persisted.virtualThreadId, {
        type: "request.opened",
        requestId: RuntimeRequestId.make("approval-child-cancel"),
        payload: { requestType: "command_execution_approval", detail: "Needs approval" },
      }),
    );
    expect(h.coordinator.findRequestRoute("approval-child-cancel")).toBeDefined();

    await h.coordinator.host.cancel(parent, child.agentRunId);

    expect(h.coordinator.findRequestRoute("approval-child-cancel")).toBeUndefined();
  });

  it("does not count failed or stopped children against the concurrency limit", async () => {
    const h = harness();
    const stopped = await h.coordinator.host.spawn(spawnInput("pi", { maxChildren: 1 }));
    await h.coordinator.host.cancel(parent, stopped.agentRunId);
    const replacement = await h.coordinator.host.spawn(spawnInput("pi", { maxChildren: 1 }));
    const persisted = h.persisted.find(
      (entry) => (entry as { agentRunId?: string }).agentRunId === replacement.agentRunId,
    ) as { virtualThreadId: ThreadId };
    await h.coordinator.handleRuntimeEvent(
      childEvent(replacement, persisted.virtualThreadId, {
        type: "runtime.error",
        payload: { message: "failed" },
      }),
    );
    await expect(h.coordinator.host.spawn(spawnInput("pi", { maxChildren: 1 }))).resolves.toEqual(
      expect.objectContaining({ status: "running" }),
    );
  });

  it("cancels one child without siblings and propagates explicit parent cancellation", async () => {
    const h = harness();
    const first = await h.coordinator.host.spawn(spawnInput());
    const second = await h.coordinator.host.spawn(spawnInput());
    await h.coordinator.host.cancel(parent, first.agentRunId);
    expect(h.coordinator.host.status(parent, [first.agentRunId])[0]?.status).toBe("stopped");
    expect(h.coordinator.host.status(parent, [second.agentRunId])[0]?.status).toBe("running");
    expect(h.pi.stopped).toHaveLength(1);
    await h.coordinator.host.cancelParent(parent);
    expect(h.coordinator.host.status(parent, [second.agentRunId])[0]?.status).toBe("stopped");
    expect(h.pi.stopped).toHaveLength(2);
  });

  it("bounds concurrency and recursion with explicit failures", async () => {
    const h = harness();
    await h.coordinator.host.spawn(spawnInput("pi", { maxChildren: 1 }));
    await expect(
      h.coordinator.host.spawn(
        spawnInput("pi", {
          parentAgentRunId: "agent:a-nested-parent-does-not-reset-the-task-cap",
          maxChildren: 1,
        }),
      ),
    ).rejects.toThrow("per-task concurrency limit");
    await expect(
      h.coordinator.host.spawn(spawnInput("pi", { depth: 3, maxDepth: 3 })),
    ).rejects.toThrow("depth limit");
  });

  it("reserves the per-task concurrency slot atomically across simultaneous spawns", async () => {
    const h = harness();
    const outcomes = await Promise.allSettled([
      h.coordinator.host.spawn(spawnInput("pi", { maxChildren: 1, description: "first" })),
      h.coordinator.host.spawn(spawnInput("pi", { maxChildren: 1, description: "second" })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(h.coordinator.host.status(parent)).toHaveLength(1);
  });

  it("restores a running child without replaying its original assignment", async () => {
    const h = harness();
    const snapshot = {
      agentRunId: "agent:restored",
      parentThreadId: parent,
      providerInstanceId: ProviderInstanceId.make("pi"),
      model: "openai/gpt-5.2",
      options: [{ id: "effort", value: "high" }],
      description: "restored child",
      status: "running" as const,
      startedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const virtualThreadId = ThreadId.make("attached:restored");
    await h.coordinator.restore({
      snapshot,
      virtualThreadId,
      driver: ProviderDriverKind.make("pi"),
      continuationPrompt: "original assignment",
    });
    await h.coordinator.resume(virtualThreadId);
    h.coordinator.completeStartupRecovery();
    await expect(h.coordinator.awaitStartupRecovery()).resolves.toEqual([
      expect.objectContaining({
        driver: "pi",
        live: true,
        snapshot: expect.objectContaining({ agentRunId: "agent:restored", status: "running" }),
      }),
    ]);
    expect(h.pi.sent).toHaveLength(0);
    expect(
      h.published.some(
        (event) =>
          event.type === "task.progress" && event.payload.parentToolUseId === "agent:restored",
      ),
    ).toBe(true);
  });

  it("reconciles an idle recovered Pi turn to paused without replaying it", async () => {
    const h = harness();
    const virtualThreadId = ThreadId.make("attached:idle-after-restart");
    h.pi.sessions.push({
      provider: ProviderDriverKind.make("pi"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      status: "ready",
      runtimeMode: "full-access",
      threadId: virtualThreadId,
      resumeCursor: { sessionId: "native-pi-session", sessionFile: "/tmp/pi-session.jsonl" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:02:00.000Z",
    });
    h.pi.threadItems.push({
      id: "user-prompt",
      type: "userMessage",
      content: [{ type: "text", text: "never replay this prompt" }],
    });
    h.pi.threadItems.push({
      id: "assistant-result",
      type: "agentMessage",
      text: "PI_RECOVERED_RESULT",
    });
    await h.coordinator.restore({
      snapshot: {
        agentRunId: "agent:idle-after-restart",
        parentThreadId: parent,
        providerInstanceId: ProviderInstanceId.make("pi"),
        description: "idle recovered child",
        status: "running",
        startedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
      },
      virtualThreadId,
      driver: ProviderDriverKind.make("pi"),
      continuationPrompt: "never replay this prompt",
    });

    await h.coordinator.resume(virtualThreadId);

    expect(h.pi.sent).toHaveLength(0);
    expect(h.coordinator.host.status(parent, ["agent:idle-after-restart"])[0]).toMatchObject({
      agentRunId: "agent:idle-after-restart",
      status: "paused",
      result: "PI_RECOVERED_RESULT",
    });
    expect(h.published).toContainEqual(
      expect.objectContaining({
        type: "task.updated",
        payload: expect.objectContaining({
          parentToolUseId: "agent:idle-after-restart",
          status: "paused",
        }),
      }),
    );
    expect(h.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "item.completed",
          itemId: "user-prompt",
          payload: expect.objectContaining({
            itemType: "user_message",
            output: "never replay this prompt",
            parentToolUseId: "agent:idle-after-restart",
          }),
        }),
        expect.objectContaining({
          type: "item.completed",
          itemId: "assistant-result",
          payload: expect.objectContaining({
            itemType: "assistant_message",
            output: "PI_RECOVERED_RESULT",
            parentToolUseId: "agent:idle-after-restart",
          }),
        }),
      ]),
    );
  });

  it("restores a paused conversation without replaying its original assignment", async () => {
    const h = harness();
    const virtualThreadId = ThreadId.make("attached:paused");
    await h.coordinator.restore({
      snapshot: {
        agentRunId: "agent:paused",
        parentThreadId: parent,
        providerInstanceId: ProviderInstanceId.make("pi"),
        description: "paused child",
        status: "paused",
        startedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
      },
      virtualThreadId,
      driver: ProviderDriverKind.make("pi"),
      continuationPrompt: "do not replay this",
    });

    await h.coordinator.resume(virtualThreadId);
    expect(h.pi.sent).toHaveLength(0);
    expect(h.coordinator.host.status(parent, ["agent:paused"])[0]?.status).toBe("paused");
  });
});
