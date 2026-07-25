import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildWorkbenchBoard } from "./Workbench.board";

const LOCAL = EnvironmentId.make("env-local");
const LAPTOP = EnvironmentId.make("env-laptop");

const CONNECTED: EnvironmentConnectionPresentation = {
  phase: "connected",
  error: null,
  traceId: null,
};

function thread(
  id: string,
  environmentId: EnvironmentId,
  overrides?: Partial<EnvironmentThreadShell>,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

const environments = [
  { environmentId: LOCAL, label: "mac", serverLabel: "mac", connection: CONNECTED },
  { environmentId: LAPTOP, label: "laptop", serverLabel: "laptop", connection: CONNECTED },
];

function board(overrides?: Partial<Parameters<typeof buildWorkbenchBoard>[0]>) {
  return buildWorkbenchBoard({
    activeThreads: [],
    snoozedThreads: [],
    settledThreads: [],
    environments,
    primaryEnvironmentId: LOCAL,
    masterCreatedThreadIds: new Set(),
    masterThreadKey: null,
    showSettled: false,
    ...overrides,
  });
}

describe("buildWorkbenchBoard", () => {
  it("groups cards by machine with the local machine first", () => {
    const result = board({
      activeThreads: [thread("t-remote", LAPTOP), thread("t-local", LOCAL)],
    });
    expect(result.groups.map((group) => group.label)).toEqual(["mac", "laptop"]);
    expect(result.groups[0]!.cards.map((card) => card.thread.id)).toEqual(["t-local"]);
    expect(result.cardCount).toBe(2);
  });

  it("keeps a machine with nothing running, because the board is a map of machines", () => {
    const result = board({ activeThreads: [thread("t-local", LOCAL)] });
    expect(result.groups).toHaveLength(2);
    expect(result.groups[1]!.cards).toEqual([]);
  });

  it("leaves the master thread to its own pane instead of duplicating it as a card", () => {
    const result = board({
      activeThreads: [thread("t-master", LOCAL), thread("t-child", LOCAL)],
      masterThreadKey: `${LOCAL}:t-master`,
    });
    expect(result.groups[0]!.cards.map((card) => card.thread.id)).toEqual(["t-child"]);
  });

  it("tags the threads the master started, matching across machines by thread id", () => {
    const result = board({
      activeThreads: [thread("t-child", LAPTOP), thread("t-mine", LOCAL)],
      masterCreatedThreadIds: new Set(["t-child"]),
    });
    const cards = result.groups.flatMap((group) => group.cards);
    expect(cards.find((card) => card.thread.id === "t-child")!.masterCreated).toBe(true);
    expect(cards.find((card) => card.thread.id === "t-mine")!.masterCreated).toBe(false);
    expect(result.masterCreatedCount).toBe(1);
  });

  it("hides settled work behind a count until it is asked for", () => {
    const hidden = board({
      activeThreads: [thread("t-active", LOCAL)],
      settledThreads: [thread("t-settled", LOCAL)],
    });
    expect(hidden.groups[0]!.cards.map((card) => card.thread.id)).toEqual(["t-active"]);
    expect(hidden.groups[0]!.settledHiddenCount).toBe(1);

    const shown = board({
      activeThreads: [thread("t-active", LOCAL)],
      settledThreads: [thread("t-settled", LOCAL)],
      showSettled: true,
    });
    expect(shown.groups[0]!.cards.map((card) => card.section)).toEqual(["active", "settled"]);
    expect(shown.groups[0]!.settledHiddenCount).toBe(0);
  });

  it("derives each card's status from the thread's own live state", () => {
    const result = board({
      activeThreads: [
        thread("t-approval", LOCAL, { hasPendingApprovals: true }),
        thread("t-working", LOCAL, {
          session: {
            threadId: ThreadId.make("t-working"),
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-07-25T00:00:00.000Z",
          },
        }),
        thread("t-quiet", LOCAL),
      ],
    });
    const statuses = new Map<string, string>(
      result.groups[0]!.cards.map((card) => [card.thread.id as string, card.status] as const),
    );
    expect(statuses.get("t-approval")).toBe("approval");
    expect(statuses.get("t-working")).toBe("working");
    expect(statuses.get("t-quiet")).toBe("ready");
  });

  it("scopes the board to one project when the caller asks, and to the fleet when it does not", () => {
    const threads = [thread("t-mine", LOCAL), thread("t-theirs", LOCAL)];

    // Default is every thread: the Workbench predates projects and must not
    // notice them.
    expect(board({ activeThreads: threads }).cardCount).toBe(2);

    const scoped = board({
      activeThreads: threads,
      includeThreadKey: (key) => key.endsWith(":t-mine"),
    });
    expect(scoped.groups.flatMap((group) => group.cards.map((card) => card.thread.id))).toEqual([
      "t-mine",
    ]);
  });

  it("does not count a filtered-out thread as settled work it is hiding", () => {
    // "Hidden" means "settled, and you asked not to see settled". A thread that
    // belongs to another project is not this board's work at all, so offering
    // to reveal it would be offering the wrong thing.
    const scoped = board({
      settledThreads: [thread("t-elsewhere", LOCAL)],
      includeThreadKey: () => false,
      showSettled: false,
    });
    expect(scoped.groups.every((group) => group.settledHiddenCount === 0)).toBe(true);
  });

  it("keeps threads whose machine is no longer a connection in a group of their own", () => {
    const orphaned = EnvironmentId.make("env-gone");
    const result = board({ activeThreads: [thread("t-orphan", orphaned)] });
    const group = result.groups.find((entry) => entry.environmentId === orphaned)!;
    expect(group.connection).toBeNull();
    expect(group.cards).toHaveLength(1);
  });
});
