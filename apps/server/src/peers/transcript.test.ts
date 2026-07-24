import { expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  comparePeerThreadsByActivity,
  peerThreadLastActivityAt,
  renderPeerTranscript,
  resolvePeerThreadStatus,
} from "./transcript.ts";

const message = (
  index: number,
  role: OrchestrationMessage["role"],
  text: string,
  turnId: string | null,
): OrchestrationMessage => ({
  id: MessageId.make(`message-${index}`),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: `2026-07-24T00:0${index}:00.000Z`,
  updatedAt: `2026-07-24T00:0${index}:00.000Z`,
});

const toolActivity = (
  index: number,
  kind: string,
  summary: string,
  turnId: string,
): OrchestrationThreadActivity => ({
  id: EventId.make(`event-${index}`),
  tone: "tool",
  kind,
  summary,
  payload: { detail: "x".repeat(50_000) },
  turnId: TurnId.make(turnId),
  createdAt: `2026-07-24T00:0${index}:00.000Z`,
});

const thread = {
  messages: [
    message(0, "user", "first", null),
    message(1, "assistant", "second", "turn-1"),
    message(2, "user", "third", null),
    message(3, "assistant", "fourth", "turn-2"),
  ],
  activities: [
    toolActivity(1, "tool.started", "Read started", "turn-1"),
    toolActivity(2, "tool.completed", "Read", "turn-1"),
    toolActivity(3, "tool.completed", "Bash", "turn-2"),
  ],
};

it("returns the newest entries and reports that older ones remain", () => {
  const page = renderPeerTranscript(thread, { limit: 2 });

  expect(page.totalEntries).toBe(4);
  expect(page.entries.map((entry) => entry.text)).toEqual(["third", "fourth"]);
  expect(page.entries.map((entry) => entry.index)).toEqual([2, 3]);
  expect(page.hasMore).toBe(true);
  expect(page.nextBefore).toBe(2);
});

it("pages backwards from nextBefore until the transcript is exhausted", () => {
  const first = renderPeerTranscript(thread, { limit: 2 });
  const second = renderPeerTranscript(thread, { limit: 2, before: first.nextBefore ?? undefined });

  expect(second.entries.map((entry) => entry.text)).toEqual(["first", "second"]);
  expect(second.hasMore).toBe(false);
  expect(second.nextBefore).toBeNull();
});

it("attaches deduped tool-call names to their turn and never the tool payload", () => {
  const page = renderPeerTranscript(thread, { limit: 4 });

  expect(page.entries[1]?.toolCalls).toEqual(["Read"]);
  expect(page.entries[3]?.toolCalls).toEqual(["Bash"]);
  expect(page.entries[0]?.toolCalls).toEqual([]);
  expect(JSON.stringify(page.entries)).not.toContain("xxxxx");
});

it("clips message text to the requested budget and flags the entry", () => {
  const page = renderPeerTranscript(
    { messages: [message(0, "assistant", "abcdefghij", "turn-1")], activities: [] },
    { limit: 1, maxTextChars: 4 },
  );

  expect(page.entries[0]?.text).toBe("abcd…");
  expect(page.entries[0]?.truncated).toBe(true);
});

const shell = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestTurn: null,
  session: null,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
} as const;

it("ranks needs-attention states above lifecycle states", () => {
  expect(resolvePeerThreadStatus({ ...shell, hasPendingApprovals: true, archivedAt: "x" })).toBe(
    "approval",
  );
  expect(resolvePeerThreadStatus({ ...shell, hasPendingUserInput: true })).toBe("input");
  expect(
    resolvePeerThreadStatus({
      ...shell,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-07-24T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    }),
  ).toBe("working");
  expect(resolvePeerThreadStatus({ ...shell, archivedAt: "2026-07-24T00:00:00.000Z" })).toBe(
    "archived",
  );
  expect(resolvePeerThreadStatus({ ...shell, settledAt: "2026-07-24T00:00:00.000Z" })).toBe(
    "settled",
  );
  expect(
    resolvePeerThreadStatus({
      ...shell,
      settledAt: "2026-07-24T00:00:00.000Z",
      settledOverride: "active",
    }),
  ).toBe("idle");
});

it("takes the latest timestamp the peer itself reported", () => {
  expect(
    peerThreadLastActivityAt({
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:01:00.000Z",
      latestUserMessageAt: "2026-07-24T00:05:00.000Z",
      latestTurn: null,
      session: null,
    }),
  ).toBe("2026-07-24T00:05:00.000Z");
});

it("sorts most recently active first with a stable tiebreak", () => {
  const base = {
    peer: "alpha",
    title: "t",
    provider: null,
    model: null,
    status: "idle",
    branch: null,
  } as const;
  const sorted = [
    { ...base, threadId: ThreadId.make("b"), lastActivityAt: "2026-07-24T00:00:00.000Z" },
    { ...base, threadId: ThreadId.make("c"), lastActivityAt: "2026-07-24T00:02:00.000Z" },
    { ...base, threadId: ThreadId.make("a"), lastActivityAt: "2026-07-24T00:00:00.000Z" },
  ].toSorted(comparePeerThreadsByActivity);

  expect(sorted.map((entry) => entry.threadId)).toEqual(["c", "a", "b"]);
});
