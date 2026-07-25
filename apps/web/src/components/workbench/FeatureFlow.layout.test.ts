import type { FeatureFlowFeature, FeatureFlowSnapshot, FeatureFlowStage } from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFeatureFlowView,
  diffFeatureStages,
  FEATURE_FLOW_LAYOUT,
  featureFlowProjectKey,
  layoutFeatureFlowSection,
  type FeatureFlowEnvironmentInput,
} from "./FeatureFlow.layout";

function feature(
  threadId: string,
  stage: FeatureFlowStage,
  overrides?: Partial<FeatureFlowFeature>,
): FeatureFlowFeature {
  return {
    threadId: ThreadId.make(threadId),
    title: threadId,
    status: "working",
    stage,
    branch: `work/${threadId}`,
    planSummary: null,
    mergeability: { state: "unknown", ahead: null, behind: null, pullRequest: null },
    dependsOn: [],
    lastActivityAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  } as FeatureFlowFeature;
}

function snapshot(
  projects: ReadonlyArray<{
    workspaceRoot: string;
    title: string;
    features: ReadonlyArray<FeatureFlowFeature>;
    diagnostics?: ReadonlyArray<string>;
  }>,
): FeatureFlowSnapshot {
  return {
    computedAt: "2026-07-25T10:00:00.000Z",
    projects: projects.map((project) => ({
      projectId: ProjectId.make(`project-${project.title}`),
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      trunks: [{ stage: "dev", ref: "origin/dev", source: "detected" }],
      features: project.features,
      diagnostics: project.diagnostics ?? [],
    })),
  } as FeatureFlowSnapshot;
}

function environment(
  overrides: Partial<FeatureFlowEnvironmentInput> & { environmentId: string; label: string },
): FeatureFlowEnvironmentInput {
  return { snapshot: null, supported: true, pending: false, ...overrides };
}

describe("featureFlowProjectKey", () => {
  it("keys on the workspace basename so one repository on two machines is one project", () => {
    expect(featureFlowProjectKey("/Users/mv/code/simcloud-platform", "SimCloud")).toBe(
      featureFlowProjectKey("/home/ubuntu/simcloud-platform/", "simcloud"),
    );
  });

  it("falls back to the title when the path has no usable segment", () => {
    expect(featureFlowProjectKey("/", "Scratch")).toBe("scratch");
  });
});

describe("buildFeatureFlowView", () => {
  it("merges the same project across machines and keeps machine identity on nodes", () => {
    const view = buildFeatureFlowView([
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshot([
          {
            workspaceRoot: "/Users/mv/hub",
            title: "hub",
            features: [feature("t-1", "in-progress")],
          },
        ]),
      }),
      environment({
        environmentId: "env-laptop",
        label: "laptop",
        snapshot: snapshot([
          { workspaceRoot: "/home/mv/hub", title: "hub", features: [feature("t-2", "in-dev")] },
        ]),
      }),
    ]);

    expect(view.sections).toHaveLength(1);
    const section = view.sections[0]!;
    expect(section.featureCount).toBe(2);
    expect(section.machineLabels).toEqual(["laptop", "mac"]);
    const laneStages = section.lanes.map((lane) => [lane.stage, lane.nodes.length] as const);
    expect(laneStages).toEqual([
      ["in-progress", 1],
      ["in-dev", 1],
      ["in-staging", 0],
      ["in-production", 0],
    ]);
    expect(section.lanes[0]!.nodes[0]!.environmentLabel).toBe("mac");
  });

  it("drops projects with no features and orders sections by how much is in flight", () => {
    const view = buildFeatureFlowView([
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshot([
          { workspaceRoot: "/a/quiet", title: "quiet", features: [] },
          { workspaceRoot: "/a/small", title: "small", features: [feature("t-1", "in-dev")] },
          {
            workspaceRoot: "/a/busy",
            title: "busy",
            features: [feature("t-2", "in-progress"), feature("t-3", "in-progress")],
          },
        ]),
      }),
    ]);
    expect(view.sections.map((section) => section.title)).toEqual(["busy", "small"]);
  });

  it("resolves dependency edges within a machine and never across machines", () => {
    const view = buildFeatureFlowView([
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshot([
          {
            workspaceRoot: "/a/hub",
            title: "hub",
            features: [
              feature("t-base", "in-progress"),
              feature("t-stacked", "in-progress", {
                dependsOn: [{ dependsOnThreadId: ThreadId.make("t-base"), source: "inferred" }],
              }),
              feature("t-dangling", "in-progress", {
                dependsOn: [{ dependsOnThreadId: ThreadId.make("t-missing"), source: "inferred" }],
              }),
            ],
          },
        ]),
      }),
      environment({
        environmentId: "env-laptop",
        label: "laptop",
        snapshot: snapshot([
          {
            workspaceRoot: "/b/hub",
            title: "hub",
            // Same thread id as the mac's base feature: a collision, not an edge.
            features: [
              feature("t-elsewhere", "in-progress", {
                dependsOn: [{ dependsOnThreadId: ThreadId.make("t-base"), source: "inferred" }],
              }),
            ],
          },
        ]),
      }),
    ]);

    const nodes = view.sections[0]!.lanes.flatMap((lane) => lane.nodes);
    const byThread = new Map(nodes.map((node) => [node.threadId, node]));
    expect(byThread.get("t-stacked")!.dependsOnKeys).toEqual(["env-mac:t-base"]);
    expect(byThread.get("t-dangling")!.dependsOnKeys).toEqual([]);
    expect(byThread.get("t-elsewhere")!.dependsOnKeys).toEqual([]);
  });

  it("leaves the orchestrator out of the lanes it orchestrates", () => {
    const environments = [
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshot([
          {
            workspaceRoot: "/a/hub",
            title: "hub",
            features: [feature("t-master", "in-progress"), feature("t-work", "in-progress")],
          },
        ]),
      }),
    ];
    const withMaster = buildFeatureFlowView(environments);
    expect(withMaster.sections[0]!.featureCount).toBe(2);

    const withoutMaster = buildFeatureFlowView(environments, {
      excludeThreadKey: "env-mac:t-master",
    });
    const titles = withoutMaster.sections[0]!.lanes.flatMap((lane) =>
      lane.nodes.map((node) => node.threadId),
    );
    expect(titles).toEqual(["t-work"]);
  });

  it("separates machines that cannot report from machines still answering", () => {
    const view = buildFeatureFlowView([
      environment({ environmentId: "env-old", label: "old-box", supported: false }),
      environment({ environmentId: "env-slow", label: "slow-box", pending: true }),
    ]);
    expect(view.unsupportedLabels).toEqual(["old-box"]);
    expect(view.pendingLabels).toEqual(["slow-box"]);
    expect(view.sections).toEqual([]);
  });

  it("attributes a project's diagnostics to the machine that reported them", () => {
    const view = buildFeatureFlowView([
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshot([
          {
            workspaceRoot: "/a/hub",
            title: "hub",
            features: [feature("t-1", "in-progress")],
            diagnostics: ["not a git repository"],
          },
        ]),
      }),
    ]);
    expect(view.sections[0]!.diagnostics).toEqual(["mac: not a git repository"]);
  });
});

describe("layoutFeatureFlowSection", () => {
  const view = buildFeatureFlowView([
    environment({
      environmentId: "env-mac",
      label: "mac",
      snapshot: snapshot([
        {
          workspaceRoot: "/a/hub",
          title: "hub",
          features: [
            feature("t-a", "in-progress", { lastActivityAt: "2026-07-25T12:00:00.000Z" }),
            feature("t-b", "in-progress", {
              lastActivityAt: "2026-07-25T11:00:00.000Z",
              dependsOn: [{ dependsOnThreadId: ThreadId.make("t-a"), source: "inferred" }],
            }),
            feature("t-c", "in-dev"),
          ],
        },
      ]),
    }),
  ]);
  const lanes = view.sections[0]!.lanes;

  it("stacks nodes without overlap and reports a height that contains them all", () => {
    const layout = layoutFeatureFlowSection(lanes);
    const sorted = [...layout.nodes].toSorted((left, right) => left.y - right.y);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.y).toBeGreaterThanOrEqual(
        sorted[index - 1]!.y + FEATURE_FLOW_LAYOUT.nodeHeight,
      );
    }
    const lastBottom = sorted[sorted.length - 1]!.y + FEATURE_FLOW_LAYOUT.nodeHeight;
    expect(layout.height).toBeGreaterThanOrEqual(lastBottom);
    expect(layout.nodes).toHaveLength(3);
  });

  it("orders nodes within a lane by most recent activity", () => {
    const layout = layoutFeatureFlowSection(lanes);
    const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
    expect(byKey.get("env-mac:t-a")!.y).toBeLessThan(byKey.get("env-mac:t-b")!.y);
  });

  it("gives empty lanes a header and a floor so no lane collapses away", () => {
    const layout = layoutFeatureFlowSection(lanes);
    expect(layout.lanes).toHaveLength(4);
    const staging = layout.lanes.find((lane) => lane.stage === "in-staging")!;
    expect(staging.nodeCount).toBe(0);
    expect(staging.height).toBe(
      FEATURE_FLOW_LAYOUT.laneHeaderHeight + FEATURE_FLOW_LAYOUT.emptyLaneHeight,
    );
    for (let index = 1; index < layout.lanes.length; index += 1) {
      expect(layout.lanes[index]!.y).toBeGreaterThanOrEqual(
        layout.lanes[index - 1]!.y + layout.lanes[index - 1]!.height,
      );
    }
  });

  it("routes one connector per resolved dependency, anchored on node centres", () => {
    const layout = layoutFeatureFlowSection(lanes);
    expect(layout.edges).toHaveLength(1);
    const edge = layout.edges[0]!;
    expect(edge.fromKey).toBe("env-mac:t-b");
    expect(edge.toKey).toBe("env-mac:t-a");
    const from = layout.nodes.find((node) => node.key === edge.fromKey)!;
    const to = layout.nodes.find((node) => node.key === edge.toKey)!;
    expect(edge.path).toContain(`M ${FEATURE_FLOW_LAYOUT.gutterWidth} ${from.centerY}`);
    expect(edge.path.endsWith(`${FEATURE_FLOW_LAYOUT.gutterWidth} ${to.centerY}`)).toBe(true);
    // The bow stays inside the rail no matter how far apart the ends are.
    const controlX = Number(edge.path.split("C ")[1]!.split(" ")[0]);
    expect(controlX).toBeGreaterThanOrEqual(0);
    expect(controlX).toBeLessThan(FEATURE_FLOW_LAYOUT.gutterWidth);
  });

  it("lays out an empty pipeline without producing nodes or edges", () => {
    const layout = layoutFeatureFlowSection([]);
    expect(layout).toMatchObject({ height: 0, nodes: [], edges: [], lanes: [] });
  });
});

describe("diffFeatureStages", () => {
  const sections = buildFeatureFlowView([
    environment({
      environmentId: "env-mac",
      label: "mac",
      snapshot: snapshot([
        { workspaceRoot: "/a/hub", title: "hub", features: [feature("t-a", "in-dev")] },
      ]),
    }),
  ]).sections;

  it("reports nothing on first sight, so opening the panel is not a merge", () => {
    const { changed, stages } = diffFeatureStages(new Map(), sections);
    expect([...changed]).toEqual([]);
    expect(stages.get("env-mac:t-a")).toBe("in-dev");
  });

  it("reports a feature that moved lane", () => {
    const { changed } = diffFeatureStages(new Map([["env-mac:t-a", "in-progress"]]), sections);
    expect([...changed]).toEqual(["env-mac:t-a"]);
  });

  it("reports nothing when a feature stays put", () => {
    const { changed } = diffFeatureStages(new Map([["env-mac:t-a", "in-dev"]]), sections);
    expect([...changed]).toEqual([]);
  });
});
