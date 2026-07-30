import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionSidebarV2Threads, type SidebarV2PartitionInput } from "./Sidebar.partition";

const NOW = "2026-04-10T00:00:00.000Z";
const CREATED_AT = "2026-04-01T00:00:00.000Z";
const LOCAL = EnvironmentId.make("env-local");

function makeThread(input: {
  readonly id: string;
  readonly environmentId?: EnvironmentId;
  readonly createdAt?: string;
  readonly activityAt?: string;
  readonly completedAt?: string;
  readonly archivedAt?: string;
  readonly pending?: "approval" | "user-input";
}): EnvironmentThreadShell {
  const threadId = ThreadId.make(input.id);
  const completedAt = input.completedAt ?? null;
  return {
    environmentId: input.environmentId ?? LOCAL,
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
    updatedAt: NOW,
    archivedAt: input.archivedAt ?? null,
    session: null,
    latestUserMessageAt: input.activityAt ?? null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
  };
}

function makeInput(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides: Partial<SidebarV2PartitionInput> = {},
): SidebarV2PartitionInput {
  return {
    threads,
    scopedProjectKeys: null,
    threadLastVisitedAtById: {},
    threadSortOrder: "activity",
    ...overrides,
  };
}

describe("partitionSidebarV2Threads", () => {
  it("hides archived threads and honours a project scope", () => {
    const visible = partitionSidebarV2Threads(
      makeInput([makeThread({ id: "archived", archivedAt: NOW }), makeThread({ id: "visible" })]),
    );
    expect(visible.map((thread) => thread.id)).toEqual(["visible"]);

    const scoped = partitionSidebarV2Threads(
      makeInput([makeThread({ id: "in-scope" })], {
        scopedProjectKeys: new Set([`${LOCAL}:other-project`]),
      }),
    );
    expect(scoped).toHaveLength(0);
  });

  it("ranks by attention band under the activity order", () => {
    const ranked = partitionSidebarV2Threads(
      makeInput([
        makeThread({ id: "quiet", activityAt: "2026-04-02T00:00:00.000Z" }),
        makeThread({ id: "blocked", pending: "approval" }),
      ]),
    );

    // Blocked-on-you work leads regardless of when it last spoke.
    expect(ranked[0]?.id).toBe("blocked");
  });

  it("falls back to newest-first creation order when asked for it", () => {
    const ordered = partitionSidebarV2Threads(
      makeInput(
        [
          makeThread({ id: "older", createdAt: "2026-04-01T00:00:00.000Z" }),
          makeThread({ id: "newer", createdAt: "2026-04-05T00:00:00.000Z" }),
        ],
        { threadSortOrder: "created_at" },
      ),
    );

    expect(ordered.map((thread) => thread.id)).toEqual(["newer", "older"]);
  });
});
