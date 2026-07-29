import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  rankThreadsForSidebarV2,
  resolveSidebarV2AttentionBand,
  sidebarV2ActivityTimestampMs,
} from "./SidebarV2.activity";

const CREATED_AT = "2026-04-01T00:00:00.000Z";

function makeShell(input: {
  readonly id: string;
  readonly createdAt?: string;
  readonly completedAt?: string | null;
  readonly latestUserMessageAt?: string | null;
  readonly sessionStatus?: "starting" | "running" | "error";
  readonly pending?: "approval" | "user-input";
}): OrchestrationThreadShell {
  const threadId = ThreadId.make(input.id);
  const completedAt = input.completedAt ?? null;
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      completedAt === null
        ? null
        : {
            turnId: TurnId.make(`turn-${input.id}`),
            state: "completed",
            requestedAt: completedAt,
            startedAt: null,
            completedAt,
            assistantMessageId: null,
          },
    createdAt: input.createdAt ?? CREATED_AT,
    updatedAt: "2026-04-10T00:00:00.000Z",
    archivedAt: null,
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
  };
}

describe("resolveSidebarV2AttentionBand", () => {
  it("bands a thread by who it is blocked on", () => {
    expect(
      resolveSidebarV2AttentionBand(makeShell({ id: "a", pending: "approval" }), {
        lastVisitedAt: undefined,
      }),
    ).toBe("approval");
    expect(
      resolveSidebarV2AttentionBand(makeShell({ id: "b", pending: "user-input" }), {
        lastVisitedAt: undefined,
      }),
    ).toBe("input");
    expect(
      resolveSidebarV2AttentionBand(makeShell({ id: "c", sessionStatus: "error" }), {
        lastVisitedAt: undefined,
      }),
    ).toBe("failed");
  });

  it("keeps a running turn quiet: nothing is waiting on a human yet", () => {
    expect(
      resolveSidebarV2AttentionBand(
        makeShell({ id: "a", sessionStatus: "running", completedAt: "2026-04-09T00:00:00.000Z" }),
        { lastVisitedAt: CREATED_AT },
      ),
    ).toBe("quiet");
  });

  it("marks a completion the viewer has not seen as unread, and a seen one as quiet", () => {
    const thread = makeShell({ id: "a", completedAt: "2026-04-09T00:00:00.000Z" });
    expect(resolveSidebarV2AttentionBand(thread, { lastVisitedAt: CREATED_AT })).toBe("unread");
    expect(
      resolveSidebarV2AttentionBand(thread, { lastVisitedAt: "2026-04-09T00:00:01.000Z" }),
    ).toBe("quiet");
  });

  it("counts a never-visited thread as read so a fresh client is not all-urgent", () => {
    expect(
      resolveSidebarV2AttentionBand(
        makeShell({ id: "a", completedAt: "2026-04-09T00:00:00.000Z" }),
        {
          lastVisitedAt: undefined,
        },
      ),
    ).toBe("quiet");
  });
});

describe("sidebarV2ActivityTimestampMs", () => {
  it("falls back to creation when a thread has never run", () => {
    expect(sidebarV2ActivityTimestampMs(makeShell({ id: "a" }))).toBe(Date.parse(CREATED_AT));
  });

  it("prefers the newest activity over creation", () => {
    expect(
      sidebarV2ActivityTimestampMs(
        makeShell({ id: "a", latestUserMessageAt: "2026-04-08T00:00:00.000Z" }),
      ),
    ).toBe(Date.parse("2026-04-08T00:00:00.000Z"));
  });

  it("survives a malformed activity stamp instead of sinking to the epoch", () => {
    expect(
      sidebarV2ActivityTimestampMs(makeShell({ id: "a", latestUserMessageAt: "not-a-date" })),
    ).toBe(Date.parse(CREATED_AT));
  });
});

describe("rankThreadsForSidebarV2", () => {
  it("orders by attention band first and activity within a band", () => {
    const threads = [
      makeShell({ id: "quiet-old", latestUserMessageAt: "2026-04-02T00:00:00.000Z" }),
      makeShell({ id: "approval", pending: "approval" }),
      makeShell({ id: "unread", completedAt: "2026-04-03T00:00:00.000Z" }),
      makeShell({ id: "input", pending: "user-input" }),
      makeShell({ id: "failed", sessionStatus: "error" }),
      makeShell({ id: "quiet-new", latestUserMessageAt: "2026-04-09T00:00:00.000Z" }),
    ];

    const ranked = rankThreadsForSidebarV2(threads, {
      lastVisitedAt: () => CREATED_AT,
    });

    expect(ranked.map((thread) => thread.id)).toEqual([
      "approval",
      "input",
      "failed",
      "unread",
      "quiet-new",
      "quiet-old",
    ]);
  });

  it("breaks ties by id so equal rows never shuffle between renders", () => {
    const threads = [makeShell({ id: "b" }), makeShell({ id: "a" })];
    const ranked = rankThreadsForSidebarV2(threads, { lastVisitedAt: () => undefined });
    expect(ranked.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input list", () => {
    const threads = [makeShell({ id: "b" }), makeShell({ id: "a", pending: "approval" })];
    rankThreadsForSidebarV2(threads, { lastVisitedAt: () => undefined });
    expect(threads.map((thread) => thread.id)).toEqual(["b", "a"]);
  });
});
