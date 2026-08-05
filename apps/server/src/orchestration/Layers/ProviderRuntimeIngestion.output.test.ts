import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

function itemEvent(
  type: "item.started" | "item.updated" | "item.completed",
  payload: Record<string, unknown>,
): ProviderRuntimeEvent {
  return {
    type,
    eventId: EventId.make(`evt-${type}`),
    provider: ProviderDriverKind.make("codex"),
    createdAt: "2026-07-18T00:00:00.000Z",
    threadId: ThreadId.make("thread-1"),
    itemId: RuntimeItemId.make("item-1"),
    payload: { itemType: "command_execution", ...payload },
  } as ProviderRuntimeEvent;
}

function payloadOf(activity: { payload: unknown } | undefined): Record<string, unknown> {
  return (activity?.payload ?? {}) as Record<string, unknown>;
}

describe("runtimeEventToActivities captured output", () => {
  it("preserves child attribution and exact launch options on task lifecycle rows", () => {
    const [started] = runtimeEventToActivities({
      type: "task.started",
      eventId: EventId.make("evt-child-started"),
      provider: ProviderDriverKind.make("pi"),
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: ThreadId.make("parent"),
      payload: {
        taskId: "agent:child",
        parentToolUseId: "agent:child",
        taskType: "attached_agent",
        options: [{ id: "effort", value: "minimal" }],
      },
    } as unknown as ProviderRuntimeEvent);
    const [progress] = runtimeEventToActivities({
      type: "task.progress",
      eventId: EventId.make("evt-child-progress"),
      provider: ProviderDriverKind.make("pi"),
      createdAt: "2026-08-01T00:00:01.000Z",
      threadId: ThreadId.make("parent"),
      payload: {
        taskId: "agent:child",
        parentToolUseId: "agent:child",
        description: "Inspecting",
      },
    } as unknown as ProviderRuntimeEvent);

    expect(payloadOf(started)).toMatchObject({
      parentToolUseId: "agent:child",
      options: [{ id: "effort", value: "minimal" }],
    });
    expect(payloadOf(progress)).toMatchObject({ parentToolUseId: "agent:child" });
  });

  it("preserves child attribution on structured input", () => {
    const [activity] = runtimeEventToActivities({
      type: "user-input.requested",
      eventId: EventId.make("evt-child-input"),
      provider: ProviderDriverKind.make("pi"),
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: ThreadId.make("parent"),
      requestId: "input-1",
      payload: {
        parentToolUseId: "agent:child",
        questions: [],
      },
    } as unknown as ProviderRuntimeEvent);
    expect(payloadOf(activity)).toMatchObject({ parentToolUseId: "agent:child" });
  });

  it("maps approval start and resolution to explicit terminal lifecycle state", () => {
    const base = {
      eventId: EventId.make("evt-approval"),
      provider: ProviderDriverKind.make("pi"),
      createdAt: "2026-08-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: "approval-1",
    };
    const [opened] = runtimeEventToActivities({
      ...base,
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: "bash: printf pi-ok",
      },
    } as ProviderRuntimeEvent);
    const [resolved] = runtimeEventToActivities({
      ...base,
      eventId: EventId.make("evt-approval-resolved"),
      type: "request.resolved",
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
        detail: "bash: printf pi-ok",
      },
    } as ProviderRuntimeEvent);

    expect(payloadOf(opened)).toMatchObject({
      requestId: "approval-1",
      status: "inProgress",
      detail: "bash: printf pi-ok",
    });
    expect(payloadOf(resolved)).toMatchObject({
      requestId: "approval-1",
      status: "completed",
      detail: "bash: printf pi-ok",
    });
  });

  it("carries output and exit code through to the activity", () => {
    const [activity] = runtimeEventToActivities(
      itemEvent("item.completed", {
        detail: "npm test",
        output: "3 passing\n1 failing",
        exitCode: 1,
      }),
    );

    const payload = payloadOf(activity);
    expect(payload.output).toBe("3 passing\n1 failing");
    expect(payload.exitCode).toBe(1);
    expect(payload.outputTruncated).toBeUndefined();
  });

  it("keeps output far past the 180-char label budget", () => {
    // The old behaviour truncated everything to the label limit, which meant no
    // command output ever reached a client.
    const output = "x".repeat(5_000);
    const [activity] = runtimeEventToActivities(
      itemEvent("item.completed", { detail: "npm test", output }),
    );

    expect(payloadOf(activity).output).toBe(output);
  });

  it("keeps the tail when output exceeds the cap, and says that it did", () => {
    // The end of a failing command's output is the part worth keeping — the
    // error and the summary line live there.
    const output = `${"a".repeat(20_000)}THE-END`;
    const [activity] = runtimeEventToActivities(
      itemEvent("item.completed", { detail: "npm test", output }),
    );

    const payload = payloadOf(activity);
    expect(payload.outputTruncated).toBe(true);
    expect(String(payload.output)).toHaveLength(16_000);
    expect(String(payload.output).endsWith("THE-END")).toBe(true);
  });

  it("still truncates the label, which is a one-liner", () => {
    const detail = "y".repeat(500);
    const [activity] = runtimeEventToActivities(itemEvent("item.completed", { detail }));

    expect(String(payloadOf(activity).detail)).toHaveLength(180);
  });

  it("stamps the provider item id on every lifecycle event so a client can join them", () => {
    for (const type of ["item.started", "item.updated", "item.completed"] as const) {
      const [activity] = runtimeEventToActivities(itemEvent(type, { detail: "npm test" }));
      expect(payloadOf(activity).itemId).toBe("item-1");
    }
  });

  it("keeps title and input data on every lifecycle event for reconnect rendering", () => {
    for (const type of ["item.started", "item.updated", "item.completed"] as const) {
      const [activity] = runtimeEventToActivities(
        itemEvent(type, {
          title: "read",
          detail: "package.json",
          data: { toolName: "read", input: { path: "package.json" } },
        }),
      );
      expect(payloadOf(activity)).toMatchObject({
        title: "read",
        data: { toolName: "read", input: { path: "package.json" } },
      });
    }
  });

  it("marks a started item as in progress rather than baking tense into the label", () => {
    const [activity] = runtimeEventToActivities(itemEvent("item.started", { detail: "npm test" }));

    expect(activity?.kind).toBe("tool.started");
    expect(activity?.summary).not.toContain("started");
    expect(payloadOf(activity).status).toBe("inProgress");
  });

  it("carries file-change line counts", () => {
    const [activity] = runtimeEventToActivities({
      type: "item.completed",
      eventId: EventId.make("evt-file-change"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      itemId: RuntimeItemId.make("item-2"),
      payload: {
        itemType: "file_change",
        detail: "src/app.ts",
        linesAdded: 22,
        linesRemoved: 3,
      },
    } as ProviderRuntimeEvent);

    const payload = payloadOf(activity);
    expect(payload.linesAdded).toBe(22);
    expect(payload.linesRemoved).toBe(3);
  });
});
