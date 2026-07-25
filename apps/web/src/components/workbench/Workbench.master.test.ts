import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { EventId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectMasterCreatedThreadIds, resolveWorkbenchMaster } from "./Workbench.master";

function activity(payload: unknown, overrides?: Partial<OrchestrationThreadActivity>) {
  return {
    id: EventId.make(`event-${Math.random().toString(36).slice(2)}`),
    tone: "tool",
    kind: "tool.completed",
    summary: "File change",
    payload,
    turnId: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  } as OrchestrationThreadActivity;
}

const claudeCreate = (threadId: string, isError = false) =>
  activity({
    itemType: "file_change",
    data: {
      toolName: "mcp__t3-code__peer_thread_create",
      input: { peer: "laptop", projectId: "project-1", title: "Feature" },
      result: {
        type: "tool_result",
        ...(isError ? { is_error: true } : {}),
        content: [
          {
            type: "text",
            text: JSON.stringify({ peer: "laptop", threadId, projectId: "p", title: "Feature" }),
          },
        ],
      },
    },
  });

const codexCreate = (threadId: string) =>
  activity({
    itemType: "mcp_tool_call",
    data: {
      item: {
        type: "mcpToolCall",
        server: "t3-code",
        tool: "peer_thread_create",
        result: { content: [], structuredContent: { peer: "mac", threadId } },
      },
    },
  });

describe("resolveWorkbenchMaster", () => {
  it("returns nothing when no machine designates a master", () => {
    expect(
      resolveWorkbenchMaster([
        { environmentId: "env-a", label: "mac", masterThreadId: "", isLocal: true },
        { environmentId: "env-b", label: "laptop", masterThreadId: "   ", isLocal: false },
      ]),
    ).toEqual({ designated: null, alternates: [] });
  });

  it("prefers the local machine's designation and lists the rest as alternates", () => {
    const resolution = resolveWorkbenchMaster([
      { environmentId: "env-b", label: "laptop", masterThreadId: "thread-laptop", isLocal: false },
      { environmentId: "env-a", label: "mac", masterThreadId: "thread-mac", isLocal: true },
      { environmentId: "env-c", label: "box", masterThreadId: "thread-box", isLocal: false },
    ]);
    expect(resolution.designated?.threadId).toBe("thread-mac");
    // Alternates are alphabetical, not catalog order.
    expect(resolution.alternates.map((entry) => entry.label)).toEqual(["box", "laptop"]);
  });

  it("falls back to alphabetical order when no designation is local", () => {
    const resolution = resolveWorkbenchMaster([
      { environmentId: "env-z", label: "zed", masterThreadId: "thread-z", isLocal: false },
      { environmentId: "env-b", label: "box", masterThreadId: "thread-b", isLocal: false },
    ]);
    expect(resolution.designated?.label).toBe("box");
  });

  it("trims the stored id so a stray space does not designate an unmatchable thread", () => {
    const resolution = resolveWorkbenchMaster([
      { environmentId: "env-a", label: "mac", masterThreadId: " thread-mac ", isLocal: true },
    ]);
    expect(resolution.designated?.threadId).toBe("thread-mac");
  });
});

describe("collectMasterCreatedThreadIds", () => {
  it("reads the created thread id out of a Claude tool result", () => {
    expect([...collectMasterCreatedThreadIds([claudeCreate("thread-child")])]).toEqual([
      "thread-child",
    ]);
  });

  it("reads the created thread id out of a Codex structured result", () => {
    expect([...collectMasterCreatedThreadIds([codexCreate("thread-child")])]).toEqual([
      "thread-child",
    ]);
  });

  it("ignores the itemType, which Claude misfiles as a file change", () => {
    // The guard this asserts: gating on itemType === "mcp_tool_call" finds
    // nothing, because "peer_thread_create" contains "create".
    const misfiled = claudeCreate("thread-child");
    expect((misfiled.payload as { itemType: string }).itemType).toBe("file_change");
    expect(collectMasterCreatedThreadIds([misfiled]).has("thread-child")).toBe(true);
  });

  it("ignores failed creates, other tools, and non-tool activities", () => {
    const ids = collectMasterCreatedThreadIds([
      claudeCreate("thread-failed", true),
      activity({
        data: { toolName: "mcp__t3-code__peer_thread_send", result: { content: [] } },
      }),
      activity({ data: { toolName: "mcp__t3-code__peer_thread_create" } }),
      activity({ data: { toolName: "mcp__t3-code__peer_thread_create", result: "not-json" } }),
      activity({ data: { toolName: "x" } }, { tone: "info" }),
      activity(null),
    ]);
    expect(ids.size).toBe(0);
  });

  it("collapses repeated creates of the same thread and keeps distinct ones", () => {
    const ids = collectMasterCreatedThreadIds([
      claudeCreate("thread-a"),
      claudeCreate("thread-a"),
      codexCreate("thread-b"),
    ]);
    expect([...ids].toSorted()).toEqual(["thread-a", "thread-b"]);
  });
});
