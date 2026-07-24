import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionSidebarV2Threads, type SidebarV2PartitionInput } from "./Sidebar.partition";

const NOW_MINUTE = "2026-04-10T00:00";
const CREATED_AT = "2026-04-01T00:00:00.000Z";
// Snooze classification runs against the real clock on purpose (a wake is
// second-precise), so shelf fixtures have to outlive the test run.
const FAR_FUTURE_WAKE = "2099-04-11T00:00:00.000Z";
const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");

function makeThread(input: {
  readonly id: string;
  readonly environmentId?: EnvironmentId;
  readonly createdAt?: string;
  readonly activityAt?: string;
  readonly completedAt?: string;
  readonly archivedAt?: string;
  readonly snoozedUntil?: string;
  readonly settledOverride?: "settled" | "active";
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
    updatedAt: `${NOW_MINUTE}:00.000Z`,
    archivedAt: input.archivedAt ?? null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === "settled" ? `${NOW_MINUTE}:00.000Z` : null,
    snoozedUntil: input.snoozedUntil ?? null,
    session: null,
    latestUserMessageAt: input.activityAt ?? null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
  };
}

const FULL_CAPABILITIES = {
  repositoryIdentity: true,
  threadSettlement: true,
  threadSnooze: true,
} satisfies ExecutionEnvironmentCapabilities;

// What an older server reports: the settle/snooze capabilities are
// optionalKey, so their absence is how skew shows up on the wire.
const LEGACY_CAPABILITIES = {
  repositoryIdentity: true,
} satisfies ExecutionEnvironmentCapabilities;

function makeInput(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides: Partial<SidebarV2PartitionInput> = {},
): SidebarV2PartitionInput {
  return {
    threads,
    scopedProjectKeys: null,
    serverConfigs: new Map([
      [LOCAL, { environment: { capabilities: FULL_CAPABILITIES } }],
      [REMOTE, { environment: { capabilities: FULL_CAPABILITIES } }],
    ]),
    changeRequestStateByKey: new Map(),
    autoSettleAfterDays: 3,
    threadLastVisitedAtById: {},
    threadSortOrder: "activity",
    nowMinute: NOW_MINUTE,
    ...overrides,
  };
}

describe("partitionSidebarV2Threads", () => {
  it("splits live shells into the inbox, the shelf, and the tail", () => {
    const partition = partitionSidebarV2Threads(
      makeInput([
        makeThread({ id: "active" }),
        makeThread({ id: "snoozed", snoozedUntil: FAR_FUTURE_WAKE }),
        makeThread({ id: "settled", settledOverride: "settled" }),
      ]),
    );

    expect(partition.activeThreads.map((thread) => thread.id)).toEqual(["active"]);
    expect(partition.snoozedThreads.map((thread) => thread.id)).toEqual(["snoozed"]);
    expect(partition.settledThreads.map((thread) => thread.id)).toEqual(["settled"]);
  });

  it("hides archived threads and honours a project scope", () => {
    const partition = partitionSidebarV2Threads(
      makeInput([
        makeThread({ id: "archived", archivedAt: `${NOW_MINUTE}:00.000Z` }),
        makeThread({ id: "visible" }),
      ]),
    );
    expect(partition.activeThreads.map((thread) => thread.id)).toEqual(["visible"]);

    const scoped = partitionSidebarV2Threads(
      makeInput([makeThread({ id: "in-scope" })], {
        scopedProjectKeys: new Set([`${LOCAL}:other-project`]),
      }),
    );
    expect(scoped.activeThreads).toHaveLength(0);
  });

  it("keeps threads from a server without the settle capability active", () => {
    const threads = [
      makeThread({ id: "settled", environmentId: REMOTE, settledOverride: "settled" }),
    ];
    const withCapability = partitionSidebarV2Threads(makeInput(threads));
    expect(withCapability.settledThreads.map((thread) => thread.id)).toEqual(["settled"]);

    // The #1 skew bug: a machine on an older server reports no settlement
    // capability, and its threads must stay in the inbox rather than land in a
    // tail where the user can neither un-settle nor pin them.
    const withoutCapability = partitionSidebarV2Threads(
      makeInput(threads, {
        serverConfigs: new Map([[REMOTE, { environment: { capabilities: LEGACY_CAPABILITIES } }]]),
      }),
    );
    expect(withoutCapability.settledThreads).toHaveLength(0);
    expect(withoutCapability.activeThreads.map((thread) => thread.id)).toEqual(["settled"]);
  });

  it("keeps threads from an environment with no descriptor at all active", () => {
    const partition = partitionSidebarV2Threads(
      makeInput(
        [makeThread({ id: "settled", environmentId: REMOTE, settledOverride: "settled" })],
        {
          serverConfigs: new Map(),
        },
      ),
    );
    expect(partition.activeThreads.map((thread) => thread.id)).toEqual(["settled"]);
  });

  it("ranks the inbox by attention when the sort order is activity", () => {
    const partition = partitionSidebarV2Threads(
      makeInput([
        makeThread({ id: "quiet", activityAt: "2026-04-09T00:00:00.000Z" }),
        makeThread({ id: "blocked", pending: "approval" }),
      ]),
    );
    expect(partition.activeThreads.map((thread) => thread.id)).toEqual(["blocked", "quiet"]);
  });

  it("falls back to upstream's static creation order when asked", () => {
    // Newest thread first, and the blocked one stays where its creation date
    // put it — the whole point of the opt-out.
    const threads = [
      makeThread({ id: "older", createdAt: "2026-04-01T00:00:00.000Z", pending: "approval" }),
      makeThread({ id: "newer", createdAt: "2026-04-05T00:00:00.000Z" }),
    ];

    const byCreation = partitionSidebarV2Threads(
      makeInput(threads, { threadSortOrder: "created_at" }),
    );
    expect(byCreation.activeThreads.map((thread) => thread.id)).toEqual(["newer", "older"]);

    const byAttention = partitionSidebarV2Threads(makeInput(threads));
    expect(byAttention.activeThreads.map((thread) => thread.id)).toEqual(["older", "newer"]);
  });

  it("orders the shelf by soonest wake", () => {
    const partition = partitionSidebarV2Threads(
      makeInput([
        makeThread({ id: "later", snoozedUntil: "2099-04-12T00:00:00.000Z" }),
        makeThread({ id: "sooner", snoozedUntil: "2099-04-11T00:00:00.000Z" }),
      ]),
    );
    expect(partition.snoozedThreads.map((thread) => thread.id)).toEqual(["sooner", "later"]);
  });
});
