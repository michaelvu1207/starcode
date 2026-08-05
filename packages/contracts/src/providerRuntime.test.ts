import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent, RuntimeEventRaw } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("keeps legacy OpenCode raw transcript events decodable", () => {
    const raw = Schema.decodeUnknownSync(RuntimeEventRaw)({
      source: "opencode.sdk.event",
      method: "message.updated",
      payload: { text: "historical response" },
    });

    expect(raw.source).toBe("opencode.sdk.event");
  });

  it("round-trips file-read lifecycle cards with reconnect-complete details", () => {
    const parsed = decodeRuntimeEvent({
      type: "item.completed",
      eventId: "event-pi-read",
      provider: "pi",
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-read-1",
      payload: {
        itemType: "file_read",
        status: "completed",
        title: "read",
        detail: "package.json",
        output: '{"name":"@starcode/monorepo"}',
        data: { toolName: "read", input: { path: "package.json" } },
      },
    });

    expect(parsed.type).toBe("item.completed");
    if (parsed.type !== "item.completed") throw new Error("expected item.completed");
    expect(parsed.payload).toMatchObject({
      itemType: "file_read",
      title: "read",
      detail: "package.json",
      status: "completed",
    });
  });

  it("round-trips a stopped tool lifecycle for explicit cancellation rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "item.completed",
      eventId: "event-pi-command-stopped",
      provider: "pi",
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-command-1",
      payload: {
        itemType: "command_execution",
        status: "stopped",
        title: "bash",
        detail: "sleep 30",
        output: "Command aborted",
      },
    });

    expect(parsed.type).toBe("item.completed");
    if (parsed.type !== "item.completed") throw new Error("expected item.completed");
    expect(parsed.payload.status).toBe("stopped");
    expect(parsed.payload.output).toBe("Command aborted");
  });

  it("round-trips heterogeneous same-task attribution without Pi-native types", () => {
    const encoded = {
      type: "task.started",
      eventId: "event-pi-child",
      provider: "pi",
      providerInstanceId: "pi_personal",
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: "parent-thread",
      payload: {
        taskId: "agent:child",
        taskType: "attached_agent",
        description: "Review the change",
        subagentType: "Pi agent",
        toolUseId: "agent:child",
        model: "openai/gpt-5.4",
        options: [{ id: "effort", value: "high" }],
        providerInstanceId: "pi_personal",
        providerDriver: "pi",
        parentAgentRunId: "agent:parent",
      },
    } as const;
    const parsed = decodeRuntimeEvent(encoded);
    expect(parsed.type).toBe("task.started");
    if (parsed.type !== "task.started") throw new Error("expected task.started");
    expect(parsed.payload).toMatchObject({
      taskId: "agent:child",
      providerInstanceId: "pi_personal",
      providerDriver: "pi",
      parentAgentRunId: "agent:parent",
      options: [{ id: "effort", value: "high" }],
    });
    expect(JSON.stringify(parsed)).not.toContain("AgentSessionEvent");
  });

  it("preserves attached lifecycle and structured-input attribution", () => {
    const progress = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "event-child-progress",
      provider: "pi",
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: "parent-thread",
      payload: {
        taskId: "agent:child",
        parentToolUseId: "agent:child",
        description: "Inspecting",
      },
    });
    expect(progress.type === "task.progress" && progress.payload.parentToolUseId).toBe(
      "agent:child",
    );

    const prompt = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-child-input",
      provider: "pi",
      createdAt: "2026-08-01T00:00:01.000Z",
      threadId: "parent-thread",
      requestId: "input-1",
      payload: {
        parentToolUseId: "agent:child",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      },
    });
    expect(prompt.type === "user-input.requested" && prompt.payload.parentToolUseId).toBe(
      "agent:child",
    );
  });

  it("preserves attached-agent attribution for approvals and errors", () => {
    const approval = decodeRuntimeEvent({
      type: "request.opened",
      eventId: "event-approval",
      provider: "pi",
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: "parent-thread",
      requestId: "approval-1",
      payload: {
        requestType: "command_execution_approval",
        detail: "run tests",
        parentToolUseId: "agent:child",
      },
    });
    expect(approval.type === "request.opened" && approval.payload.parentToolUseId).toBe(
      "agent:child",
    );
    const error = decodeRuntimeEvent({
      type: "runtime.error",
      eventId: "event-error",
      provider: "pi",
      createdAt: "2026-08-01T00:00:01.000Z",
      threadId: "parent-thread",
      payload: { message: "child failed", parentToolUseId: "agent:child" },
    });
    expect(error.type === "runtime.error" && error.payload.parentToolUseId).toBe("agent:child");
  });

  it("keeps approval operation detail on resolution for reconnect rendering", () => {
    const resolved = decodeRuntimeEvent({
      type: "request.resolved",
      eventId: "event-approval-resolved",
      provider: "pi",
      createdAt: "2026-08-01T00:00:02.000Z",
      threadId: "parent-thread",
      requestId: "approval-1",
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
        detail: "bash: printf pi-ok",
        args: { command: "printf pi-ok" },
      },
    });
    expect(resolved.type).toBe("request.resolved");
    if (resolved.type !== "request.resolved") throw new Error("expected request.resolved");
    expect(resolved.payload).toMatchObject({
      decision: "accept",
      detail: "bash: printf pi-ok",
      args: { command: "printf pi-ok" },
    });
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
});
