import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@starcode/contracts";
import type { SupervisorConnectionState } from "@starcode/client-runtime/connection";
import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { deriveDiscordPresenceSummary, discordPresenceSummaryEquals } from "./discordPresence";

const environmentId = (value: string) => value as EnvironmentId;
const threadId = (value: string) => value as ThreadId;

function shell(overrides: Partial<EnvironmentThreadShell>): EnvironmentThreadShell {
  return {
    id: threadId("thread-1"),
    environmentId: environmentId("mac"),
    projectId: "project-1",
    title: "Untitled",
    modelSelection: null,
    runtimeMode: "default",
    interactionMode: "chat",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

const runningTurn = (
  requestedAt: string,
  startedAt: string | null = requestedAt,
): OrchestrationThreadShell["latestTurn"] => ({
  turnId: `turn-${requestedAt}` as TurnId,
  state: "running",
  requestedAt,
  startedAt,
  completedAt: null,
  assistantMessageId: null,
});

const connections = (
  ...phases: ReadonlyArray<SupervisorConnectionState["phase"]>
): ReadonlyMap<EnvironmentId, SupervisorConnectionState> =>
  new Map(
    phases.map((phase, index) => [
      environmentId(`env-${index}`),
      { phase } as SupervisorConnectionState,
    ]),
  );

describe("deriveDiscordPresenceSummary", () => {
  it("counts running threads and takes the oldest start as the timer origin", () => {
    const summary = deriveDiscordPresenceSummary({
      threads: [
        shell({ id: threadId("a"), latestTurn: runningTurn("2026-07-28T10:05:00.000Z") }),
        shell({ id: threadId("b"), latestTurn: runningTurn("2026-07-28T10:01:00.000Z") }),
        shell({ id: threadId("c"), latestTurn: runningTurn("2026-07-28T10:09:00.000Z") }),
      ],
      connectionStates: connections("connected", "connected"),
    });

    expect(summary.runningThreadCount).toBe(3);
    expect(summary.runningSince).toBe("2026-07-28T10:01:00.000Z");
  });

  it("uses the request instant for a turn the provider has not picked up yet", () => {
    const summary = deriveDiscordPresenceSummary({
      threads: [shell({ latestTurn: runningTurn("2026-07-28T10:00:00.000Z", null) })],
      connectionStates: connections("connected"),
    });

    expect(summary.runningSince).toBe("2026-07-28T10:00:00.000Z");
  });

  it("counts each of the three attention signals, once per thread", () => {
    const summary = deriveDiscordPresenceSummary({
      threads: [
        shell({ id: threadId("a"), hasPendingApprovals: true }),
        shell({ id: threadId("b"), hasPendingUserInput: true }),
        shell({ id: threadId("c"), hasActionableProposedPlan: true }),
        shell({ id: threadId("d"), hasPendingApprovals: true, hasPendingUserInput: true }),
        shell({ id: threadId("e") }),
      ],
      connectionStates: connections("connected"),
    });

    expect(summary.attentionThreadCount).toBe(4);
  });

  it("does not count a running thread as also needing attention", () => {
    // A running turn with a pending approval is one thread, and the presence
    // says what it is doing rather than double-counting it in both lines.
    const summary = deriveDiscordPresenceSummary({
      threads: [
        shell({ latestTurn: runningTurn("2026-07-28T10:00:00.000Z"), hasPendingApprovals: true }),
      ],
      connectionStates: connections("connected"),
    });

    expect(summary).toMatchObject({ runningThreadCount: 1, attentionThreadCount: 0 });
  });

  it("ignores archived threads, whose last turn never changes again", () => {
    const summary = deriveDiscordPresenceSummary({
      threads: [
        shell({
          id: threadId("a"),
          archivedAt: "2026-07-20T10:00:00.000Z",
          latestTurn: runningTurn("2026-07-20T09:00:00.000Z"),
        }),
        shell({
          id: threadId("b"),
          archivedAt: "2026-07-20T10:00:00.000Z",
          hasPendingApprovals: true,
        }),
      ],
      connectionStates: connections("connected"),
    });

    expect(summary).toMatchObject({
      runningThreadCount: 0,
      attentionThreadCount: 0,
      runningSince: null,
    });
  });

  it("counts only connections that are actually connected", () => {
    const summary = deriveDiscordPresenceSummary({
      threads: [],
      connectionStates: connections("connected", "backoff", "connecting", "connected", "offline"),
    });

    expect(summary.connectedEnvironmentCount).toBe(2);
  });
});

describe("discordPresenceSummaryEquals", () => {
  it("compares every field the presence is built from", () => {
    const base = deriveDiscordPresenceSummary({
      threads: [shell({ latestTurn: runningTurn("2026-07-28T10:00:00.000Z") })],
      connectionStates: connections("connected"),
    });

    expect(discordPresenceSummaryEquals(base, { ...base })).toBe(true);
    expect(discordPresenceSummaryEquals(base, { ...base, runningThreadCount: 2 })).toBe(false);
    expect(discordPresenceSummaryEquals(base, { ...base, attentionThreadCount: 1 })).toBe(false);
    expect(discordPresenceSummaryEquals(base, { ...base, connectedEnvironmentCount: 2 })).toBe(
      false,
    );
    expect(discordPresenceSummaryEquals(base, { ...base, runningSince: null })).toBe(false);
  });
});
