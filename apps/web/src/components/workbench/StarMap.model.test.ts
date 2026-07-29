import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectCategorySlug,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { FeatureMapEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FeatureFlowFeatureNode, FeatureFlowView } from "./FeatureFlow.model";
import { buildSkyModel, latestFeature, type SkyModelInput } from "./StarMap.model";
import type { WorkbenchBoard, WorkbenchBoardCard, WorkbenchBoardGroup } from "./Workbench.board";
import type { SidebarV2Status } from "../Sidebar.logic";

const MAC = EnvironmentId.make("env-mac");
const LAPTOP = EnvironmentId.make("env-laptop");

function shell(
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
  overrides?: Partial<WorkbenchBoardCard> & {
    environmentId?: EnvironmentId;
    threadOverrides?: Partial<EnvironmentThreadShell>;
  },
): WorkbenchBoardCard {
  const { threadOverrides, environmentId, ...rest } = overrides ?? {};
  const env = environmentId ?? MAC;
  return {
    key: `${env}:${id}`,
    thread: shell(id, env, threadOverrides),
    status: "idle" as SidebarV2Status,
    masterCreated: false,
    ...rest,
  };
}

function group(
  cards: ReadonlyArray<WorkbenchBoardCard>,
  environmentId: EnvironmentId = MAC,
  label = "mac",
): WorkbenchBoardGroup {
  return {
    environmentId,
    label,
    isLocal: environmentId === MAC,
    connection: null,
    cards,
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
    unreadableLabels: [],
    diagnostics: [],
    ...overrides,
  };
}

function mapEntry(id: string, overrides?: Partial<FeatureMapEntry>): FeatureMapEntry {
  return {
    id,
    name: id,
    description: null,
    threadId: null,
    slug: null,
    stage: "in-progress",
    dependsOn: [],
    planned: false,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  } as FeatureMapEntry;
}

function machineMap(entries: ReadonlyArray<FeatureMapEntry>, label = "mac") {
  return new Map([["env-mac", { label, entries }]]);
}

function model(overrides?: Partial<SkyModelInput>) {
  return buildSkyModel({
    board: board([group([])]),
    flow: flow(),
    mapEntriesByEnvironment: new Map(),
    master: null,
    projectTitleByKey: new Map(),
    ...overrides,
  });
}

describe("buildSkyModel", () => {
  it("puts every machine's work in one sky, with the machine as a detail only", () => {
    const built = model({
      board: board([
        group([card("t-1")]),
        group([card("t-2", { environmentId: LAPTOP })], LAPTOP, "simforgelaptop"),
      ]),
    });

    // Ordered by key, which namespaces the machine — the only trace machines
    // leave on the sky's shape, and one that never becomes geography.
    expect(built.features.map((feature) => feature.name)).toEqual(["t-2", "t-1"]);
    expect(built.features.map((feature) => feature.machineLabel)).toEqual([
      "simforgelaptop",
      "mac",
    ]);
  });

  it("lifts a feature to the tier its machine reports, and says so when nothing can", () => {
    const built = model({
      board: board([group([card("t-1"), card("t-2")])]),
      flow: flow({ features: [featureNode("t-1", { stage: "in-staging" })] }),
    });

    const byName = new Map(built.features.map((feature) => [feature.name, feature]));
    expect(byName.get("t-1")!.stage).toBe("in-staging");
    expect(byName.get("t-1")!.stageReported).toBe(true);
    expect(byName.get("t-2")!.stage).toBe("in-progress");
    expect(byName.get("t-2")!.stageReported).toBe(false);
  });

  it("lets the orchestrator's entry name and place the thread it claims", () => {
    const built = model({
      board: board([group([card("t-1")])]),
      flow: flow({ features: [featureNode("t-1", { stage: "in-progress" })] }),
      mapEntriesByEnvironment: machineMap([
        mapEntry("aaaaaaaaaaaa", {
          name: "Conversation import",
          description: "Resume a session as a thread.",
          threadId: ThreadId.make("t-1"),
          // A promotion the orchestrator performed outranks the derived stage.
          stage: "in-staging",
        }),
      ]),
    });

    expect(built.features).toHaveLength(1);
    const feature = built.features[0]!;
    expect(feature.name).toBe("Conversation import");
    expect(feature.description).toBe("Resume a session as a thread.");
    expect(feature.stage).toBe("in-staging");
    expect(feature.masterAuthored).toBe(true);
    // The thread's own facts survive: the star still opens, and still pulses.
    expect(feature.threadRef).toEqual({ environmentId: "env-mac", threadId: "t-1" });
  });

  it("keeps a planned feature as intent, with nothing to open", () => {
    const built = model({
      mapEntriesByEnvironment: machineMap([
        mapEntry("bbbbbbbbbbbb", { name: "Sky on mobile", planned: true }),
      ]),
    });

    expect(built.plannedCount).toBe(1);
    expect(built.realCount).toBe(0);
    expect(built.features[0]!.threadRef).toBeNull();
    expect(built.features[0]!.planned).toBe(true);
  });

  it("redirects a derived link through whatever the orchestrator claimed", () => {
    const built = model({
      board: board([group([card("t-base"), card("t-stacked")])]),
      flow: flow({
        features: [
          featureNode("t-base"),
          featureNode("t-stacked", { dependsOnKeys: ["env-mac:t-base"] }),
        ],
      }),
      mapEntriesByEnvironment: machineMap([
        mapEntry("cccccccccccc", { name: "Base", threadId: ThreadId.make("t-base") }),
      ]),
    });

    const stacked = built.features.find((feature) => feature.name === "t-stacked")!;
    // The link now points at the map entry, not at the raw thread key.
    expect(stacked.dependsOnKeys).toEqual(["map:env-mac:cccccccccccc"]);
  });

  it("drops a link that points off the sky", () => {
    const built = model({
      board: board([group([card("t-stacked")])]),
      flow: flow({
        features: [featureNode("t-stacked", { dependsOnKeys: ["env-mac:t-gone"] })],
      }),
    });

    expect(built.features[0]!.dependsOnKeys).toEqual([]);
  });

  it("marks work as landed once something can say which trunk holds it", () => {
    const built = model({
      board: board([group([card("t-landed"), card("t-open")])]),
      flow: flow({ features: [featureNode("t-landed", { stage: "in-production" })] }),
    });

    const byName = new Map(built.features.map((feature) => [feature.name, feature]));
    expect(byName.get("t-landed")!.landed).toBe(true);
    // Nothing has said where this one reached, so it has not landed anywhere.
    expect(byName.get("t-open")!.landed).toBe(false);
  });

  it("names machines that cannot report tiers, and stays silent about the unasked", () => {
    const built = model({
      board: board([group([card("t-1", { status: "working" as SidebarV2Status })])]),
      flow: flow({ unsupportedLabels: ["path-pc"], pendingLabels: ["simforge1"] }),
    });

    expect(built.stageUnsupportedLabels).toEqual(["path-pc"]);
    expect(built.features[0]!.alive).toBe(true);
  });

  it("orders by key, so a finished turn cannot reshape the tree", () => {
    const built = model({
      board: board([
        group([
          card("t-zulu", { threadOverrides: { updatedAt: "2026-07-25T12:00:00.000Z" } }),
          card("t-alpha", { threadOverrides: { updatedAt: "2026-07-25T01:00:00.000Z" } }),
        ]),
      ]),
    });

    expect(built.features.map((feature) => feature.name)).toEqual(["t-alpha", "t-zulu"]);
  });
});

describe("buildSkyModel, scoped to a project", () => {
  const atlas = ProjectCategorySlug.make("atlas");

  /** A scope that claims exactly the given `environmentId:threadId` keys. */
  const scopeOver = (...keys: ReadonlyArray<string>) => {
    const claimed = new Set(keys);
    return { slug: atlas, includeThreadKey: (key: string) => claimed.has(key) };
  };

  it("leaves another project's features off this project's sky", () => {
    // The bug this scope exists for: `includeThreadKey` reached the board and
    // the flow, and the map entries walked straight past it, so /projects/$slug
    // rendered every machine's entire feature map.
    const built = model({
      mapEntriesByEnvironment: machineMap([
        mapEntry("aaaaaaaaaaaa", { name: "Ours", slug: atlas }),
        mapEntry("bbbbbbbbbbbb", {
          name: "Theirs",
          slug: ProjectCategorySlug.make("beacon"),
        }),
      ]),
      scope: scopeOver(),
    });

    expect(built.features.map((feature) => feature.name)).toEqual(["Ours"]);
  });

  it("keeps a planned feature, which has no thread to be filtered by", () => {
    const built = model({
      mapEntriesByEnvironment: machineMap([
        mapEntry("aaaaaaaaaaaa", { name: "Intended", planned: true, slug: atlas }),
      ]),
      scope: scopeOver(),
    });

    expect(built.features.map((feature) => feature.name)).toEqual(["Intended"]);
    expect(built.plannedCount).toBe(1);
  });

  it("keeps an unfiled feature whose thread the project claims", () => {
    const built = model({
      board: board([group([card("t-1")])]),
      mapEntriesByEnvironment: machineMap([
        mapEntry("aaaaaaaaaaaa", { name: "Inherited", threadId: ThreadId.make("t-1") }),
      ]),
      scope: scopeOver("env-mac:t-1"),
    });

    expect(built.features.map((feature) => feature.name)).toEqual(["Inherited"]);
  });

  it("drops an unfiled feature whose thread belongs to somebody else", () => {
    // No board entry for t-2: `buildWorkbenchBoard` takes the same scope's
    // thread predicate, so a thread this project does not claim never reaches
    // the sky as a card either. This is the map half of that filter.
    const built = model({
      mapEntriesByEnvironment: machineMap([
        mapEntry("aaaaaaaaaaaa", { name: "Elsewhere", threadId: ThreadId.make("t-2") }),
      ]),
      scope: scopeOver("env-mac:t-1"),
    });

    expect(built.features).toEqual([]);
  });

  it("folds a project's features across machines", () => {
    // The rollup, and the reason it is the client's job: each server answered
    // only about itself, and the union of those answers is this.
    const built = model({
      mapEntriesByEnvironment: new Map([
        ["env-mac", { label: "mac", entries: [mapEntry("aaaaaaaaaaaa", { slug: atlas })] }],
        [
          "env-laptop",
          { label: "simforgelaptop", entries: [mapEntry("bbbbbbbbbbbb", { slug: atlas })] },
        ],
      ]),
      scope: scopeOver(),
    });

    expect(built.features.map((feature) => feature.machineLabel)).toEqual([
      "simforgelaptop",
      "mac",
    ]);
  });

  it("shows the whole fleet's map when no project scopes it", () => {
    const built = model({
      mapEntriesByEnvironment: machineMap([
        mapEntry("aaaaaaaaaaaa", { name: "Ours", slug: atlas }),
        mapEntry("bbbbbbbbbbbb", { name: "Theirs", slug: ProjectCategorySlug.make("beacon") }),
        mapEntry("cccccccccccc", { name: "Unfiled" }),
      ]),
    });

    expect(built.features.map((feature) => feature.name).toSorted()).toEqual([
      "Ours",
      "Theirs",
      "Unfiled",
    ]);
  });
});

describe("latestFeature", () => {
  it("ignores the plan, which has no activity of its own", () => {
    const built = model({
      board: board([
        group([card("t-old", { threadOverrides: { updatedAt: "2026-07-20T00:00:00.000Z" } })]),
      ]),
      mapEntriesByEnvironment: machineMap([
        mapEntry("dddddddddddd", {
          name: "Planned",
          planned: true,
          updatedAt: "2026-07-26T00:00:00.000Z",
        }),
      ]),
    });

    expect(latestFeature(built)!.name).toBe("t-old");
  });

  it("returns nothing for an empty sky", () => {
    expect(latestFeature(model())).toBeNull();
  });
});
