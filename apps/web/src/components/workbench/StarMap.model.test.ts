import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FeatureFlowFeatureNode, FeatureFlowView } from "./FeatureFlow.model";
import { buildStarMapModel, latestStar, type StarMapModelInput } from "./StarMap.model";
import type { WorkbenchBoard, WorkbenchBoardCard, WorkbenchBoardGroup } from "./Workbench.board";
import type { SidebarV2Status } from "../Sidebar.logic";

const MAC = EnvironmentId.make("env-mac");

function shell(id: string, overrides?: Partial<EnvironmentThreadShell>): EnvironmentThreadShell {
  return {
    environmentId: MAC,
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
    planSummary: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

function card(
  id: string,
  overrides?: Partial<WorkbenchBoardCard> & { threadOverrides?: Partial<EnvironmentThreadShell> },
): WorkbenchBoardCard {
  const { threadOverrides, ...rest } = overrides ?? {};
  return {
    key: `env-mac:${id}`,
    thread: shell(id, threadOverrides),
    section: "active",
    status: "idle" as SidebarV2Status,
    masterCreated: false,
    ...rest,
  };
}

function group(cards: ReadonlyArray<WorkbenchBoardCard>): WorkbenchBoardGroup {
  return {
    environmentId: MAC,
    label: "mac",
    isLocal: true,
    connection: null,
    cards,
    settledHiddenCount: 0,
  };
}

function board(groups: ReadonlyArray<WorkbenchBoardGroup>): WorkbenchBoard {
  return {
    groups,
    cardCount: groups.reduce((total, entry) => total + entry.cards.length, 0),
    masterCreatedCount: 0,
  };
}

function featureNode(
  threadId: string,
  overrides?: Partial<FeatureFlowFeatureNode>,
): FeatureFlowFeatureNode {
  return {
    key: `env-mac:${threadId}`,
    threadId,
    environmentId: "env-mac",
    environmentLabel: "mac",
    title: threadId,
    status: "working",
    stage: "in-dev",
    planSummary: null,
    mergeability: { state: "unknown", ahead: null, behind: null, pullRequest: null },
    dependsOnKeys: [],
    lastActivityAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  } as FeatureFlowFeatureNode;
}

function flow(overrides?: Partial<FeatureFlowView>): FeatureFlowView {
  return {
    features: [],
    unsupportedLabels: [],
    pendingLabels: [],
    diagnostics: [],
    ...overrides,
  };
}

function model(overrides?: Partial<StarMapModelInput>) {
  return buildStarMapModel({
    board: board([group([])]),
    flow: flow(),
    master: null,
    projectTitleByKey: new Map(),
    ...overrides,
  });
}

describe("buildStarMapModel", () => {
  it("lifts a thread to the stage its machine reports, and parks it at the horizon otherwise", () => {
    const built = model({
      board: board([group([card("t-1"), card("t-2")])]),
      flow: flow({ features: [featureNode("t-1", { stage: "in-staging" })] }),
    });

    const stars = new Map(built.regions[0]!.stars.map((star) => [star.threadId, star]));
    expect(stars.get("t-1")!.stage).toBe("in-staging");
    expect(stars.get("t-1")!.stageReported).toBe(true);
    // No machine could place t-2, so it sits at the horizon and says so rather
    // than claiming a stage nobody reported.
    expect(stars.get("t-2")!.stage).toBe("in-progress");
    expect(stars.get("t-2")!.stageReported).toBe(false);
  });

  it("keeps in-flight work from a machine that cannot report stages, and names the gap", () => {
    const built = model({
      board: board([group([card("t-1", { status: "working" as SidebarV2Status })])]),
      flow: flow({ unsupportedLabels: ["path-pc"] }),
    });

    expect(built.starCount).toBe(1);
    expect(built.regions[0]!.stars[0]!.alive).toBe(true);
    expect(built.stageUnsupportedLabels).toEqual(["path-pc"]);
  });

  it("stays silent about machines that have not been asked", () => {
    const built = model({ flow: flow({ pendingLabels: ["simforge1"] }) });
    expect(built.stageUnsupportedLabels).toEqual([]);
    expect(built.regions).toEqual([]);
  });

  it("draws settled work only where a machine can say where it landed", () => {
    const built = model({
      board: board([
        group([
          card("t-landed", { section: "settled" }),
          card("t-forgotten", { section: "settled" }),
        ]),
      ]),
      flow: flow({ features: [featureNode("t-landed", { stage: "in-production" })] }),
    });

    const stars = built.regions[0]!.stars;
    expect(stars.map((star) => star.threadId)).toEqual(["t-landed"]);
    expect(stars[0]!.settled).toBe(true);
    expect(stars[0]!.stage).toBe("in-production");
  });

  it("keeps a landed feature whose thread has left the in-flight view", () => {
    const built = model({
      board: board([group([])]),
      flow: flow({
        features: [featureNode("t-merged", { stage: "in-dev", status: "settled" })],
      }),
    });

    expect(built.regions[0]!.stars.map((star) => star.threadId)).toEqual(["t-merged"]);
    expect(built.regions[0]!.stars[0]!.settled).toBe(true);
  });

  it("never draws the same work twice when both sources carry it", () => {
    const built = model({
      board: board([group([card("t-1")])]),
      flow: flow({ features: [featureNode("t-1")] }),
    });

    expect(built.starCount).toBe(1);
  });

  it("orders stars by key, so a completed turn cannot reshuffle the sky", () => {
    const built = model({
      board: board([
        group([
          card("t-zulu", { threadOverrides: { updatedAt: "2026-07-25T12:00:00.000Z" } }),
          card("t-alpha", { threadOverrides: { updatedAt: "2026-07-25T01:00:00.000Z" } }),
        ]),
      ]),
    });

    expect(built.regions[0]!.stars.map((star) => star.threadId)).toEqual(["t-alpha", "t-zulu"]);
  });

  it("drops a machine with nothing to show rather than drawing an empty region", () => {
    const built = model({ board: board([group([]), group([card("t-1")])]) });
    expect(built.regions).toHaveLength(1);
  });

  it("carries the project title and the orchestrator's mark onto the star", () => {
    const built = model({
      board: board([group([card("t-1", { masterCreated: true })])]),
      projectTitleByKey: new Map([["env-mac:project-1", "hub"]]),
    });

    expect(built.regions[0]!.stars[0]!.projectTitle).toBe("hub");
    expect(built.regions[0]!.stars[0]!.masterCreated).toBe(true);
  });
});

describe("latestStar", () => {
  it("finds the most recently touched work across every region", () => {
    const built = model({
      board: board([
        group([
          card("t-old", { threadOverrides: { updatedAt: "2026-07-20T00:00:00.000Z" } }),
          card("t-new", { threadOverrides: { updatedAt: "2026-07-25T00:00:00.000Z" } }),
        ]),
      ]),
    });

    expect(latestStar(built)!.threadId).toBe("t-new");
  });

  it("returns nothing for an empty sky", () => {
    expect(latestStar(model())).toBeNull();
  });
});
