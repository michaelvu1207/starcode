import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveSubagentTasks,
  mainThreadActivities,
  agentActivities,
  activityParentToolUseId,
  deriveTimelineEntries,
  deriveAgentTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  PROVIDER_OPTIONS,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
} from "./session-logic";

describe("provider options", () => {
  it("exposes Pi as the sole launchable runtime", () => {
    expect(PROVIDER_OPTIONS).toEqual([{ value: "pi", label: "Pi", available: true }]);
  });
});

let nextActivityId = 0;

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("deriveAgentTimelineEntries", () => {
  it("renders one AgentRun as ordinary messages, reasoning, and tools without sibling leakage", () => {
    const own = "agent:own";
    const activities = [
      makeActivity({
        id: "agent-user",
        kind: "agent.user.message",
        createdAt: "2026-08-01T00:00:01.000Z",
        payload: {
          itemId: "user-1",
          parentToolUseId: own,
          output: "Please inspect this",
          status: "completed",
        },
      }),
      makeActivity({
        id: "agent-reasoning",
        kind: "agent.reasoning",
        createdAt: "2026-08-01T00:00:02.000Z",
        payload: {
          itemId: "reasoning-1",
          parentToolUseId: own,
          output: "I should inspect the implementation.",
        },
      }),
      makeActivity({
        id: "agent-tool",
        kind: "tool.completed",
        createdAt: "2026-08-01T00:00:03.000Z",
        payload: {
          itemId: "tool-1",
          itemType: "command_execution",
          parentToolUseId: own,
          title: "bash",
          output: "ok",
          status: "completed",
        },
      }),
      makeActivity({
        id: "agent-response",
        kind: "agent.message",
        createdAt: "2026-08-01T00:00:04.000Z",
        payload: {
          itemId: "assistant-1",
          parentToolUseId: own,
          output: "Inspection complete",
          status: "completed",
        },
      }),
      makeActivity({
        id: "sibling-response",
        kind: "agent.message",
        payload: {
          itemId: "assistant-secret",
          parentToolUseId: "agent:sibling",
          output: "sibling secret",
        },
      }),
    ];

    const timeline = deriveAgentTimelineEntries(activities, own);
    expect(timeline.map((entry) => entry.kind)).toEqual([
      "message",
      "reasoning",
      "work",
      "message",
    ]);
    expect(
      timeline.flatMap((entry) => (entry.kind === "message" ? [entry.message.text] : [])),
    ).toEqual(["Please inspect this", "Inspection complete"]);
    expect(JSON.stringify(timeline)).not.toContain("sibling secret");
  });

  it("keeps attributed child lifecycle rows visible without parent or sibling leakage", () => {
    const own = "agent:own";
    const activities = [
      makeActivity({ id: "parent", kind: "tool.completed", payload: { detail: "parent work" } }),
      makeActivity({
        id: "progress",
        kind: "task.progress",
        payload: {
          taskId: own,
          parentToolUseId: own,
          summary: "Inspecting files",
        },
      }),
      makeActivity({
        id: "paused",
        kind: "task.updated",
        payload: { taskId: own, parentToolUseId: own, status: "paused" },
      }),
      makeActivity({
        id: "sibling",
        kind: "task.progress",
        payload: {
          taskId: "agent:sibling",
          parentToolUseId: "agent:sibling",
          summary: "Sibling secret",
        },
      }),
    ];

    expect(mainThreadActivities(activities).map((activity) => activity.id)).toEqual(["parent"]);
    const child = deriveAgentTimelineEntries(activities, own);
    expect(child.map((entry) => entry.id).toSorted()).toEqual(["paused", "progress"]);
    expect(JSON.stringify(child)).toContain("Inspecting files");
    expect(JSON.stringify(child)).not.toContain("Sibling secret");
  });

  it("renders the exact attributed runtime failure text", () => {
    const timeline = deriveAgentTimelineEntries(
      [
        makeActivity({
          id: "failure",
          kind: "runtime.error",
          tone: "error",
          summary: "Runtime error",
          payload: {
            parentToolUseId: "agent:own",
            message: "credential minting failed",
            detail: "credential minting failed",
          },
        }),
      ],
      "agent:own",
    );
    expect(JSON.stringify(timeline)).toContain("credential minting failed");
  });
});

describe("derivePendingUserInputs", () => {
  it("retains AgentRun attribution so sibling prompts can be isolated", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-user-input",
        createdAt: "2026-02-23T00:00:00.000Z",
        kind: "user-input.requested",
        summary: "Agent needs input",
        tone: "info",
        payload: {
          requestId: "req-agent-input",
          parentToolUseId: "agent:child",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Continue?",
              options: [{ label: "yes", description: "Continue" }],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)[0]?.parentToolUseId).toBe("agent:child");
  });

  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: req-user-input-stale-1",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("falls back to the most recent plan from a previous turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-from-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Write tests", status: "completed" }],
        },
      }),
    ];

    // Current turn is turn-2, which has no plan activity — should fall back to turn-1's plan
    const result = deriveActivePlanState(activities, TurnId.make("turn-2"));
    expect(result).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      turnId: "turn-1",
      steps: [{ step: "Write tests", status: "completed" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.make("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.make("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.make("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.make("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.make("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.make("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.make("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it("is true for error tone", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "error",
        detail: "nothing special",
      }),
    ).toBe(true);
  });

  it("is true when lifecycle says failed even if detail is empty", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "failed",
      }),
    ).toBe(true);
  });

  it("detects file-not-found style tool output with completed lifecycle", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "File not found: C:\\foo\\nonexistent.ts",
      }),
    ).toBe(true);
  });

  it("detects glob no files and PowerShell command errors", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Glob",
        tone: "tool",
        detail: "No files found",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Bash",
        tone: "tool",
        detail:
          "The term 'this_is_not_a_command' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      }),
    ).toBe(true);
  });

  it("is false for successful completed tools", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "Found 3 matching files",
      }),
    ).toBe(false);
  });

  it("treats successful tool rows as success candidates", () => {
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(false);
    expect(workEntryIndicatesToolSuccess({ ...base, tone: "thinking", detail: "…" })).toBe(false);
    // Not neutral: neutral rows get filtered out of the timeline, and a tool
    // that is still running is precisely the row worth showing.
    expect(
      workEntryIndicatesToolNeutralStatus({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(false);
    expect(
      workEntryIndicatesToolNeutralStatus({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(false);
    // Stopped rows are terminal but intentionally neither success nor failure.
    // They still carry the cancellation result and must remain visible.
    expect(
      workEntryIndicatesToolNeutralStatus({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "stopped",
        detail: "Command aborted",
      }),
    ).toBe(false);
  });

  it("does not run heuristics on non-tool info rows", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Context compacted",
        tone: "info",
        detail: "File not found in conversation",
      }),
    ).toBe(false);
  });
});

describe("deriveWorkLogEntries", () => {
  it("folds approval request and resolution into one attributed terminal row", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "approval-open",
        createdAt: "2026-08-01T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "approval-1",
          requestKind: "command",
          status: "inProgress",
          detail: "bash: printf pi-ok",
        },
      }),
      makeActivity({
        id: "approval-resolved",
        createdAt: "2026-08-01T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "approval",
        payload: {
          requestId: "approval-1",
          requestKind: "command",
          status: "completed",
          detail: "bash: printf pi-ok",
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "approval-open",
      detail: "bash: printf pi-ok",
      requestKind: "command",
      sourceActivityKind: "approval.resolved",
      toolLifecycleStatus: "completed",
    });
  });

  it("folds a tool's start into its completion and keeps the start's position", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
        payload: { itemId: "item-1", itemType: "command_execution" },
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
        payload: { itemId: "item-1", itemType: "command_execution" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    // One row, anchored where the work started rather than where it finished —
    // the row exists for the whole time the tool is running.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("tool-start");
    expect(entries[0]?.createdAt).toBe("2026-02-23T00:00:02.000Z");
    expect(entries[0]?.toolLifecycleStatus).toBe("completed");
  });

  it("keeps a still-running tool as its own in-progress entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
        payload: { itemId: "item-1", itemType: "command_execution" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolLifecycleStatus).toBe("inProgress");
  });

  it("does not merge concurrent tool calls that interleave", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "start-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Bash",
        kind: "tool.started",
        payload: { itemId: "item-a", itemType: "command_execution" },
      }),
      makeActivity({
        id: "start-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Bash",
        kind: "tool.started",
        payload: { itemId: "item-b", itemType: "command_execution" },
      }),
      makeActivity({
        id: "complete-a",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Bash",
        kind: "tool.completed",
        payload: { itemId: "item-a", itemType: "command_execution" },
      }),
      makeActivity({
        id: "complete-b",
        createdAt: "2026-02-23T00:00:04.000Z",
        summary: "Bash",
        kind: "tool.completed",
        payload: { itemId: "item-b", itemType: "command_execution" },
      }),
    ];

    // Two calls, not four rows and not one: the completions are not adjacent to
    // their starts, so an adjacency-only merge would get this wrong.
    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["start-a", "start-b"]);
  });

  it("carries captured output and exit code onto the merged entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Bash",
        kind: "tool.started",
        payload: { itemId: "item-1", itemType: "command_execution" },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Bash",
        kind: "tool.completed",
        payload: {
          itemId: "item-1",
          itemType: "command_execution",
          output: "boom\n",
          outputTruncated: true,
          exitCode: 1,
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.output).toBe("boom");
    expect(entry?.outputTruncated).toBe(true);
    expect(entry?.exitCode).toBe(1);
  });

  it("omits task.started but shows task.progress and task.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "task-complete"]);
  });

  it("uses payload summary as label for task entries when available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-progress-with-summary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: { summary: "Searching for API endpoints" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Searching for API endpoints");
  });

  it("uses payload detail as label for task.completed and preserves error tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Failed to deploy changes");
    expect(entries[0]?.tone).toBe("error");
  });

  it("keeps tool entries from every turn and tags each with its turn id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        turnId: "turn-1",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "turn-2-tool",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-tool", "turn-2-tool"]);
    expect(entries.map((entry) => entry.turnId)).toEqual([
      TurnId.make("turn-1"),
      TurnId.make("turn-2"),
    ]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bun run lint");
  });

  it("extracts failed tool lifecycle status from item payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-failed",
        kind: "tool.updated",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          status: "failed",
          detail: "No files found",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("failed");
  });

  it("defaults tool.completed entries to completed lifecycle status", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-done",
        kind: "tool.completed",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          detail: "Found 3 files",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("completed");
  });

  it("preserves MCP server, tool, arguments, and results for expanded display", () => {
    const item = {
      type: "mcpToolCall",
      server: "starcode",
      tool: "preview_status",
      arguments: {},
      status: "completed",
      result: { content: [{ type: "text", text: "attached" }] },
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-done",
        kind: "tool.completed",
        summary: "starcode · preview_status",
        payload: {
          itemType: "mcp_tool_call",
          title: "starcode · preview_status",
          data: { item },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("starcode · preview_status");
    expect(entry?.toolData).toEqual(item);
  });

  it("keeps MCP payloads while collapsing lifecycle updates", () => {
    const item = {
      type: "mcpToolCall",
      server: "starcode",
      tool: "preview_snapshot",
      arguments: { interactiveOnly: true },
      status: "completed",
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-progress",
        kind: "tool.updated",
        summary: "starcode · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
          data: { item },
        },
      }),
      makeActivity({
        id: "mcp-tool-complete",
        kind: "tool.completed",
        summary: "starcode · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolData).toEqual(item);
  });

  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bun run lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    );
  });

  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper-argv",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it("extracts command text from command detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-detail-fallback",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail:
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });

  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-shell-script",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "bash script.sh",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("drops duplicated tool detail when it only repeats the title", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-file-generic",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("Read File");
    expect(entry?.detail).toBeUndefined();
  });

  it("uses grep raw output summaries instead of repeating the generic tool label", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grep-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "grep-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawOutput: {
              totalFiles: 19,
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "grep-update",
      toolTitle: "grep",
      detail: "19 files",
      itemType: "web_search",
    });
  });

  it("uses completed read-file output previews and still collapses the same tool call", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content:
                'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-update",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("does not use command stdout as the detail when Cursor omits the command input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-command-complete",
        createdAt: "2026-04-16T22:40:42.221Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "toolu_vrtx_01WypXgRM8PPygBtrVAZwzy5",
            kind: "execute",
            rawInput: {},
            rawOutput: {
              exitCode: 0,
              stdout: "total 960\napps\npackages\n",
              stderr: "",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      id: "cursor-command-complete",
      label: "Ran command",
      itemType: "command_execution",
      toolTitle: "Ran command",
    });
    expect(entry?.detail).toBeUndefined();
    expect(entry?.command).toBeUndefined();
  });

  it("collapses legacy completed tool rows that are missing tool metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-legacy",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "legacy-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "legacy-read-update",
      toolTitle: "Read File",
      itemType: "dynamic_tool_call",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    // Identity and position come from the first event so the row holds still
    // while the tool runs; the later events contribute their content.
    expect(entries[0]).toMatchObject({
      id: "tool-update-1",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-update", "tool-2-update"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("z-update-earlier");
  });
});

describe("deriveTimelineEntries", () => {
  it("hides system-authored managed-goal continuation messages", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("managed-goal-message"),
          role: "user",
          authoredBy: "system",
          text: "Continue working toward the active goal",
          createdAt: "2026-02-23T00:00:01.000Z",
          turnId: null,
          updatedAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(entries).toEqual([]);
  });

  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          turnId: null,
          updatedAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "context-1",
        turnId: "turn-1",
        kind: "context-window.updated",
        summary: "Context window updated",
        tone: "info",
      }),
      makeActivity({
        id: "tool-1",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Ran command",
        tone: "tool",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "compaction-1",
        turnId: "turn-1",
        kind: "context-compaction",
        summary: "Context compacted",
        tone: "info",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "ready",
        activeTurnId: null,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("uses the new send start while the session is running a different turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "ready",
          activeTurnId: null,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

/**
 * The tasks panel's reducer.
 *
 * The token rule is the one that matters: `total_tokens` is a running total per
 * task, so a reducer that accumulates reports roughly the square of the truth —
 * and it does so plausibly, climbing smoothly, which is exactly the kind of
 * wrong nobody notices. Two of these exist to make that regression loud.
 */
describe("deriveSubagentTasks", () => {
  const started = (taskId: string, overrides: Record<string, unknown> = {}) =>
    makeActivity({
      kind: "task.started",
      createdAt: "2026-07-27T00:00:00.000Z",
      payload: {
        taskId,
        detail: "Find the thing",
        taskType: "local_agent",
        subagentType: "Explore",
        toolUseId: `toolu_${taskId}`,
        ...overrides,
      },
    });

  const progress = (taskId: string, totalTokens: number, overrides: Record<string, unknown> = {}) =>
    makeActivity({
      kind: "task.progress",
      createdAt: "2026-07-27T00:00:01.000Z",
      payload: {
        taskId,
        title: "Running Search",
        lastToolName: "Bash",
        usage: { total_tokens: totalTokens, tool_uses: 2, duration_ms: 4000 },
        ...overrides,
      },
    });

  it("folds the four task events into one row per subagent", () => {
    const [task] = deriveSubagentTasks([
      started("a1"),
      progress("a1", 18945),
      makeActivity({
        kind: "task.completed",
        createdAt: "2026-07-27T00:00:02.000Z",
        payload: { taskId: "a1", status: "completed", summary: "Search complete." },
      }),
    ]);

    expect(task?.taskId).toBe("a1");
    expect(task?.taskType).toBe("local_agent");
    expect(task?.subagentType).toBe("Explore");
    expect(task?.toolUseId).toBe("toolu_a1");
    expect(task?.status).toBe("completed");
    expect(task?.summary).toBe("Search complete.");
    // Nothing is running, so the live subtitle must not linger.
    expect(task?.lastToolName).toBeNull();
  });

  it("replaces token totals instead of accumulating them", () => {
    // Real numbers from a logged run: one subagent climbed 18,945 -> 81,724
    // across 117 progress events. Summed, that would read as millions.
    const [task] = deriveSubagentTasks([
      started("a1"),
      progress("a1", 18945),
      progress("a1", 22490),
      progress("a1", 81724),
    ]);

    expect(task?.totalTokens).toBe(81724);
  });

  it("keeps the last token figure when the terminal event carries no usage", () => {
    // Only a minority of completions carry usage; treating the omission as zero
    // would blank the number exactly when it becomes final.
    const [task] = deriveSubagentTasks([
      started("a1"),
      progress("a1", 81724),
      makeActivity({
        kind: "task.completed",
        createdAt: "2026-07-27T00:00:02.000Z",
        payload: { taskId: "a1", status: "completed" },
      }),
    ]);

    expect(task?.totalTokens).toBe(81724);
    expect(task?.status).toBe("completed");
  });

  it("surfaces a killed subagent instead of leaving it running forever", () => {
    // A killed task never reaches a terminal notification, so without the patch
    // it reads as still working — the bug this event was wired up to fix.
    const [task] = deriveSubagentTasks([
      started("a1"),
      progress("a1", 500),
      makeActivity({
        kind: "task.updated",
        createdAt: "2026-07-27T00:00:03.000Z",
        payload: { taskId: "a1", status: "killed", detail: "user interrupted" },
      }),
    ]);

    expect(task?.status).toBe("stopped");
    expect(task?.error).toBe("user interrupted");
  });

  it("still builds a row for a task first seen mid-flight", () => {
    // After a reconnect the first event a client sees may be progress, not
    // start. Dropping those would make the panel decay over a long session.
    const [task] = deriveSubagentTasks([progress("a1", 4200, { subagentType: "code-reviewer" })]);

    expect(task?.taskId).toBe("a1");
    expect(task?.subagentType).toBe("code-reviewer");
    expect(task?.totalTokens).toBe(4200);
    expect(task?.status).toBe("running");
  });

  it("sorts live subagents first and finished subagents newest-first", () => {
    const tasks = deriveSubagentTasks([
      started("older-done"),
      makeActivity({
        kind: "task.completed",
        createdAt: "2026-07-27T00:00:02.000Z",
        payload: { taskId: "older-done", status: "completed" },
      }),
      started("live"),
      progress("live", 100),
      makeActivity({
        kind: "task.started",
        createdAt: "2026-07-27T00:00:03.000Z",
        payload: { taskId: "newer-done" },
      }),
      makeActivity({
        kind: "task.completed",
        createdAt: "2026-07-27T00:00:04.000Z",
        payload: { taskId: "newer-done", status: "completed" },
      }),
    ]);

    expect(tasks.map((task) => task.taskId)).toEqual(["live", "newer-done", "older-done"]);
  });

  it("discovers a historical nested Codex CLI launch from its exact Bash item", () => {
    const tool = makeActivity({
      id: "codex-tool-updated",
      kind: "tool.updated",
      payload: {
        providerItemId: "toolu_codex_1",
        status: "inProgress",
        data: {
          toolName: "Bash",
          input: {
            command:
              'nohup codex exec -C phase2-router -m gpt-5.6-sol "Consolidate the route representation." > /tmp/worker.log 2>&1 &',
          },
        },
      },
    });

    const [task] = deriveSubagentTasks([tool]);
    expect(task).toMatchObject({
      taskId: "codex-cli:toolu_codex_1",
      description: "Consolidate the route representation.",
      subagentType: "Codex CLI",
      model: "gpt-5.6-sol",
      status: "running",
      isBackgrounded: true,
      toolUseId: "toolu_codex_1",
      lastToolName: "codex exec",
    });
  });

  it("keeps an exact linked rollout id on the Codex CLI task", () => {
    const historySessionId = "a".repeat(32);
    const [task] = deriveSubagentTasks([
      started("codex-cli:toolu_codex_2", {
        subagentType: "Codex CLI",
        toolUseId: "toolu_codex_2",
        historySessionId,
      }),
    ]);
    expect(task?.historySessionId).toBe(historySessionId);
  });

  it("opens a uniquely recovered historical Codex rollout", () => {
    const historySessionId = "c".repeat(32);
    const [task] = deriveSubagentTasks([
      makeActivity({
        kind: "tool.updated",
        payload: {
          providerItemId: "toolu_historical_codex",
          codexCliHistorySessionId: historySessionId,
          codexCliRolloutStatus: "completed",
          data: {
            toolName: "Bash",
            input: {
              command:
                'cd /work/router && nohup codex exec -C . "Review the route graph." > /tmp/codex.log 2>&1 &',
            },
          },
        },
      }),
    ]);
    expect(task).toMatchObject({
      status: "completed",
      historySessionId,
      subagentType: "Codex CLI",
    });
  });

  it("opens a recovered historical Codex rollout joined through legacy itemId rows", () => {
    const historySessionId = "d".repeat(32);
    const itemId = "toolu_legacy_historical_codex";
    const command =
      'cd /work/router && nohup codex exec -C . "Review the route graph." ' +
      "> /tmp/codex.log 2>&1 &";
    const [task] = deriveSubagentTasks([
      makeActivity({
        id: "legacy-codex-updated",
        kind: "tool.updated",
        payload: {
          itemId,
          codexCliHistorySessionId: historySessionId,
          codexCliRolloutStatus: "completed",
          data: { toolName: "Bash", input: { command } },
        },
      }),
      makeActivity({
        id: "legacy-codex-completed",
        kind: "tool.completed",
        payload: {
          itemId,
          status: "completed",
          data: { toolName: "Bash", input: { command } },
        },
      }),
    ]);

    expect(task).toMatchObject({
      taskId: `codex-cli:${itemId}`,
      toolUseId: itemId,
      status: "completed",
      historySessionId,
      subagentType: "Codex CLI",
    });
  });

  it("uses a recovered stopped rollout to close an older stale lifecycle row", () => {
    const itemId = "toolu_stale_codex";
    const historySessionId = "e".repeat(32);
    const [task] = deriveSubagentTasks([
      makeActivity({
        id: "stale-codex-wrapper",
        kind: "tool.updated",
        createdAt: "2026-07-27T00:00:01.000Z",
        payload: {
          itemId,
          codexCliHistorySessionId: historySessionId,
          codexCliRolloutStatus: "stopped",
          codexCliRolloutStatusAt: "2026-07-28T00:00:01.000Z",
          data: {
            toolName: "Bash",
            input: { command: 'nohup codex exec "Review the graph." > /tmp/log 2>&1 &' },
          },
        },
      }),
      makeActivity({
        id: "stale-codex-started",
        kind: "task.started",
        // A replayed task.started after service restart is not proof that the
        // already-terminal rollout became live again.
        createdAt: "2026-07-29T00:00:02.000Z",
        payload: {
          taskId: `codex-cli:${itemId}`,
          toolUseId: itemId,
          subagentType: "Codex CLI",
        },
      }),
    ]);

    expect(task).toMatchObject({
      taskId: `codex-cli:${itemId}`,
      status: "stopped",
      historySessionId,
      updatedAt: "2026-07-28T00:00:01.000Z",
    });
  });

  it("does not let an older recovered terminal state override newer live progress", () => {
    const itemId = "toolu_resumed_codex";
    const historySessionId = "f".repeat(32);
    const [task] = deriveSubagentTasks([
      makeActivity({
        id: "resumed-codex-wrapper",
        kind: "tool.updated",
        createdAt: "2026-07-27T00:00:01.000Z",
        payload: {
          itemId,
          codexCliHistorySessionId: historySessionId,
          codexCliRolloutStatus: "completed",
          codexCliRolloutStatusAt: "2026-07-27T00:00:03.000Z",
          data: {
            toolName: "Bash",
            input: { command: 'codex exec "Review the graph."' },
          },
        },
      }),
      makeActivity({
        id: "resumed-codex-started",
        kind: "task.started",
        createdAt: "2026-07-27T00:00:02.000Z",
        payload: {
          taskId: `codex-cli:${itemId}`,
          toolUseId: itemId,
          subagentType: "Codex CLI",
        },
      }),
      makeActivity({
        id: "resumed-codex-progress",
        kind: "task.progress",
        createdAt: "2026-07-27T00:00:04.000Z",
        payload: {
          taskId: `codex-cli:${itemId}`,
          status: "running",
          lastToolName: "exec",
        },
      }),
    ]);

    expect(task).toMatchObject({
      status: "running",
      historySessionId,
      updatedAt: "2026-07-27T00:00:04.000Z",
    });
  });

  it("closes unmatched live rows once their owning provider session is fully stopped", () => {
    const [task] = deriveSubagentTasks(
      [
        makeActivity({
          id: "unmatched-codex-started",
          kind: "task.started",
          createdAt: "2026-07-27T00:00:02.000Z",
          payload: {
            taskId: "codex-cli:toolu_unmatched",
            toolUseId: "toolu_unmatched",
            subagentType: "Codex CLI",
          },
        }),
      ],
      {
        owningSession: {
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-07-27T00:00:05.000Z",
        },
      },
    );

    expect(task).toMatchObject({
      status: "stopped",
      summary: "Owning provider session stopped.",
      updatedAt: "2026-07-27T00:00:05.000Z",
    });
  });

  it("keeps task activity observed after the owning session stop live", () => {
    const [task] = deriveSubagentTasks(
      [
        makeActivity({
          id: "newer-codex-started",
          kind: "task.started",
          createdAt: "2026-07-27T00:00:02.000Z",
          payload: {
            taskId: "codex-cli:toolu_newer",
            toolUseId: "toolu_newer",
            subagentType: "Codex CLI",
          },
        }),
        makeActivity({
          id: "newer-codex-progress",
          kind: "task.progress",
          createdAt: "2026-07-27T00:00:06.000Z",
          payload: {
            taskId: "codex-cli:toolu_newer",
            status: "running",
            lastToolName: "exec",
          },
        }),
      ],
      {
        owningSession: {
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-07-27T00:00:05.000Z",
        },
      },
    );

    expect(task).toMatchObject({
      status: "running",
      updatedAt: "2026-07-27T00:00:06.000Z",
    });
  });

  it("keeps an exactly linked detached rollout live when historical observation says running", () => {
    const itemId = "toolu_observed_detached";
    const historySessionId = "1".repeat(32);
    const [task] = deriveSubagentTasks(
      [
        makeActivity({
          id: "observed-detached-wrapper",
          kind: "tool.updated",
          createdAt: "2026-07-27T00:00:01.000Z",
          payload: {
            itemId,
            codexCliHistorySessionId: historySessionId,
            codexCliRolloutStatus: "running",
            codexCliRolloutStatusAt: "2026-07-27T00:00:04.000Z",
            codexCliRolloutLiveness: "live",
            data: {
              toolName: "Bash",
              input: { command: 'nohup codex exec "Review the graph." > /tmp/log 2>&1 &' },
            },
          },
        }),
      ],
      {
        owningSession: {
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-07-27T00:00:05.000Z",
        },
      },
    );

    expect(task).toMatchObject({
      status: "running",
      historySessionId,
      isBackgrounded: true,
    });
  });

  it("does not protect an unprobed recent rollout after its provider runtime stopped", () => {
    const itemId = "toolu_unprobed_detached";
    const historySessionId = "2".repeat(32);
    const [task] = deriveSubagentTasks(
      [
        makeActivity({
          id: "unprobed-detached-wrapper",
          kind: "tool.updated",
          createdAt: "2026-07-27T00:00:01.000Z",
          payload: {
            itemId,
            codexCliHistorySessionId: historySessionId,
            codexCliRolloutStatus: "running",
            codexCliRolloutStatusAt: "2026-07-27T00:00:04.000Z",
            codexCliRolloutLiveness: "unknown",
            data: {
              toolName: "Bash",
              input: { command: 'nohup codex exec "Review the graph." > /tmp/log 2>&1 &' },
            },
          },
        }),
      ],
      {
        owningSession: {
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-07-27T00:00:05.000Z",
        },
      },
    );

    expect(task).toMatchObject({
      status: "stopped",
      historySessionId,
      updatedAt: "2026-07-27T00:00:05.000Z",
    });
  });

  it("does not let a detached Bash wrapper overwrite the linked rollout terminal state", () => {
    const toolUseId = "toolu_codex_linked";
    const [task] = deriveSubagentTasks([
      started(`codex-cli:${toolUseId}`, {
        subagentType: "Codex CLI",
        toolUseId,
      }),
      makeActivity({
        kind: "tool.completed",
        payload: {
          providerItemId: toolUseId,
          status: "completed",
          data: {
            toolName: "Bash",
            input: { command: 'nohup codex exec "Review the graph." > /tmp/log 2>&1 &' },
          },
        },
      }),
      makeActivity({
        kind: "task.completed",
        payload: {
          taskId: `codex-cli:${toolUseId}`,
          status: "completed",
          historySessionId: "b".repeat(32),
        },
      }),
    ]);
    expect(task?.status).toBe("completed");
    expect(task?.historySessionId).toBe("b".repeat(32));
  });

  it("ignores activities that are not tasks", () => {
    expect(
      deriveSubagentTasks([
        makeActivity({ kind: "tool.started", payload: { toolCallId: "t-1" } }),
        makeActivity({ kind: "turn.plan.updated", payload: { plan: [] } }),
      ]),
    ).toEqual([]);
  });
});

describe("subagent activity partitioning", () => {
  it("leaves a thread that never spawned an agent completely alone", () => {
    // The fast path, and the guarantee that turning subagent forwarding on
    // changes nothing for threads that use no agents. Identity, not a copy.
    const activities = [
      makeActivity({ kind: "tool.started", sequence: 1 }),
      makeActivity({ kind: "tool.completed", sequence: 2 }),
    ];

    expect(mainThreadActivities(activities)).toBe(activities);
  });

  it("keeps subagent rows out of the thread's own transcript", () => {
    const own = makeActivity({ id: "own", kind: "tool.started", sequence: 1 });
    const borrowed = makeActivity({
      id: "borrowed",
      kind: "tool.started",
      sequence: 2,
      payload: { parentToolUseId: "toolu_01" },
    });

    expect(mainThreadActivities([own, borrowed]).map((a) => a.id)).toEqual(["own"]);
  });

  it("keeps an attached-agent approval actionable while excluding it from parent prose", () => {
    const approval = makeActivity({
      id: "child-approval",
      kind: "approval.requested",
      payload: {
        parentToolUseId: "agent:pi-child",
        requestId: "req-child",
        requestType: "command_execution_approval",
        detail: "bash: sleep 8",
      },
    });

    expect(mainThreadActivities([approval])).toEqual([]);
    expect(derivePendingApprovals([approval])).toMatchObject([
      {
        requestId: "req-child",
        requestKind: "command",
        detail: "bash: sleep 8",
      },
    ]);
  });

  it("gives each agent only its own rows", () => {
    const first = makeActivity({
      id: "a1",
      kind: "agent.message",
      payload: { parentToolUseId: "toolu_01", detail: "one" },
    });
    const second = makeActivity({
      id: "b1",
      kind: "agent.message",
      payload: { parentToolUseId: "toolu_02", detail: "two" },
    });
    const own = makeActivity({ id: "own", kind: "tool.started" });

    expect(agentActivities([first, second, own], "toolu_01").map((a) => a.id)).toEqual(["a1"]);
    expect(agentActivities([first, second, own], "toolu_02").map((a) => a.id)).toEqual(["b1"]);
  });

  it("folds an attached agent message from running to its terminal output", () => {
    const startedMessage = makeActivity({
      id: "message-started",
      kind: "agent.message",
      sequence: 1,
      payload: {
        itemId: "pi-message-1",
        parentToolUseId: "toolu_01",
        status: "inProgress",
        title: "Pi response",
      },
    });
    const completedMessage = makeActivity({
      id: "message-completed",
      kind: "agent.message",
      sequence: 2,
      payload: {
        itemId: "pi-message-1",
        parentToolUseId: "toolu_01",
        status: "completed",
        title: "Pi response",
        detail: "Child result",
        output: "Child result",
      },
    });

    expect(deriveWorkLogEntries([startedMessage, completedMessage])).toMatchObject([
      {
        id: "message-started",
        providerItemId: "pi-message-1",
        toolLifecycleStatus: "completed",
        output: "Child result",
      },
    ]);
  });

  it("moves all lifecycle rows for a detected Codex Bash item into its agent view", () => {
    const startedTool = makeActivity({
      id: "codex-started",
      kind: "tool.started",
      payload: { providerItemId: "toolu_codex" },
    });
    const updatedTool = makeActivity({
      id: "codex-updated",
      kind: "tool.updated",
      payload: {
        providerItemId: "toolu_codex",
        data: {
          toolName: "Bash",
          input: { command: 'codex exec "Review the graph."' },
        },
      },
    });
    const own = makeActivity({ id: "own", kind: "tool.updated" });

    expect(mainThreadActivities([startedTool, updatedTool, own]).map((row) => row.id)).toEqual([
      "own",
    ]);
    expect(
      agentActivities([startedTool, updatedTool, own], "toolu_codex").map((row) => row.id),
    ).toEqual(["codex-started", "codex-updated"]);
  });

  it("moves legacy itemId lifecycle rows into the Codex agent view", () => {
    const itemId = "toolu_legacy_codex";
    const startedTool = makeActivity({
      id: "legacy-codex-started",
      kind: "tool.started",
      payload: { itemId },
    });
    const updatedTool = makeActivity({
      id: "legacy-codex-updated",
      kind: "tool.updated",
      payload: {
        itemId,
        data: {
          toolName: "Bash",
          input: { command: 'codex exec "Review the graph."' },
        },
      },
    });
    const completedTool = makeActivity({
      id: "legacy-codex-completed",
      kind: "tool.completed",
      payload: { itemId },
    });
    const own = makeActivity({ id: "own", kind: "tool.updated" });

    expect(
      mainThreadActivities([startedTool, updatedTool, completedTool, own]).map((row) => row.id),
    ).toEqual(["own"]);
    expect(
      agentActivities([startedTool, updatedTool, completedTool, own], itemId).map((row) => row.id),
    ).toEqual(["legacy-codex-started", "legacy-codex-updated", "legacy-codex-completed"]);
  });

  it("returns nothing for an agent whose tool-use id was never reported", () => {
    // An honest empty view beats showing someone else's rows under this
    // agent's name — which is what a null key matching null payloads would do.
    const orphan = makeActivity({ id: "own", kind: "tool.started" });

    expect(agentActivities([orphan], null)).toEqual([]);
  });

  it("treats a blank parentToolUseId as main-thread work", () => {
    const blank = makeActivity({
      id: "blank",
      kind: "tool.started",
      payload: { parentToolUseId: "   " },
    });

    expect(mainThreadActivities([blank]).map((a) => a.id)).toEqual(["blank"]);
    expect(activityParentToolUseId(blank)).toBeNull();
  });
});
