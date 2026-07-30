import type {
  FeatureFlowFeature,
  FeatureFlowSnapshot,
  FeatureFlowStage,
} from "@starcode/contracts";
import { ProjectId, ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFeatureFlowView,
  diffFeatureStages,
  featureFlowStageProgress,
  type FeatureFlowEnvironmentInput,
} from "./FeatureFlow.model";

export function featureFixture(
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

export function snapshotFixture(
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

describe("buildFeatureFlowView", () => {
  it("flattens every machine's projects into one list that keeps machine identity", () => {
    const view = buildFeatureFlowView([
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshotFixture([
          {
            workspaceRoot: "/Users/mv/hub",
            title: "hub",
            features: [featureFixture("t-1", "in-progress")],
          },
        ]),
      }),
      environment({
        environmentId: "env-laptop",
        label: "laptop",
        snapshot: snapshotFixture([
          {
            workspaceRoot: "/home/mv/hub",
            title: "hub",
            features: [featureFixture("t-2", "in-dev")],
          },
        ]),
      }),
    ]);

    expect(view.features.map((feature) => [feature.key, feature.environmentLabel])).toEqual([
      ["env-mac:t-1", "mac"],
      ["env-laptop:t-2", "laptop"],
    ]);
    expect(view.features[1]!.stage).toBe("in-dev");
  });

  it("resolves dependency edges within a machine and never across machines", () => {
    const view = buildFeatureFlowView([
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshotFixture([
          {
            workspaceRoot: "/a/hub",
            title: "hub",
            features: [
              featureFixture("t-base", "in-dev"),
              featureFixture("t-stacked", "in-progress", {
                dependsOn: [{ dependsOnThreadId: ThreadId.make("t-base"), source: "inferred" }],
              } as Partial<FeatureFlowFeature>),
              featureFixture("t-orphan", "in-progress", {
                // Lives on the other machine: the id collides but means nothing here.
                dependsOn: [
                  { dependsOnThreadId: ThreadId.make("t-elsewhere"), source: "inferred" },
                ],
              } as Partial<FeatureFlowFeature>),
            ],
          },
        ]),
      }),
      environment({
        environmentId: "env-laptop",
        label: "laptop",
        snapshot: snapshotFixture([
          {
            workspaceRoot: "/b/hub",
            title: "hub",
            features: [featureFixture("t-elsewhere", "in-dev")],
          },
        ]),
      }),
    ]);

    const byKey = new Map(view.features.map((feature) => [feature.key, feature]));
    expect(byKey.get("env-mac:t-stacked")!.dependsOnKeys).toEqual(["env-mac:t-base"]);
    expect(byKey.get("env-mac:t-orphan")!.dependsOnKeys).toEqual([]);
  });

  it("leaves the orchestrator out of the work it orchestrates", () => {
    const view = buildFeatureFlowView(
      [
        environment({
          environmentId: "env-mac",
          label: "mac",
          snapshot: snapshotFixture([
            {
              workspaceRoot: "/a/hub",
              title: "hub",
              features: [
                featureFixture("t-master", "in-progress"),
                featureFixture("t-1", "in-dev"),
              ],
            },
          ]),
        }),
      ],
      { excludeThreadKey: "env-mac:t-master" },
    );

    expect(view.features.map((feature) => feature.threadId)).toEqual(["t-1"]);
  });

  it("scopes the view to one project when the caller asks, and to the fleet when it does not", () => {
    const machines = [
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshotFixture([
          {
            workspaceRoot: "/a/hub",
            title: "hub",
            features: [featureFixture("t-mine", "in-dev"), featureFixture("t-theirs", "in-dev")],
          },
        ]),
      }),
    ];

    // The default is every feature — `/workbench` must not change because
    // projects exist.
    expect(buildFeatureFlowView(machines).features).toHaveLength(2);

    const scoped = buildFeatureFlowView(machines, {
      includeThreadKey: (key) => key === "env-mac:t-mine",
    });
    expect(scoped.features.map((feature) => feature.threadId)).toEqual(["t-mine"]);
  });

  it("drops a dependency edge onto work the filter excluded", () => {
    // Otherwise a project's sky would draw a branch to a star that is not in
    // it, which is a line to nowhere.
    const scoped = buildFeatureFlowView(
      [
        environment({
          environmentId: "env-mac",
          label: "mac",
          snapshot: snapshotFixture([
            {
              workspaceRoot: "/a/hub",
              title: "hub",
              features: [
                featureFixture("t-base", "in-dev"),
                featureFixture("t-stacked", "in-progress", {
                  dependsOn: [{ dependsOnThreadId: ThreadId.make("t-base"), source: "inferred" }],
                } as Partial<FeatureFlowFeature>),
              ],
            },
          ]),
        }),
      ],
      { includeThreadKey: (key) => key === "env-mac:t-stacked" },
    );

    expect(scoped.features.map((feature) => feature.threadId)).toEqual(["t-stacked"]);
    expect(scoped.features[0]!.dependsOnKeys).toEqual([]);
  });

  it("separates machines that cannot report from machines still answering", () => {
    const view = buildFeatureFlowView([
      environment({ environmentId: "env-old", label: "path-pc", supported: false }),
      environment({ environmentId: "env-off", label: "simforge1", pending: true }),
    ]);

    expect(view.unsupportedLabels).toEqual(["path-pc"]);
    expect(view.pendingLabels).toEqual(["simforge1"]);
    expect(view.unreadableLabels).toEqual([]);
  });

  it("names a connected machine that claims it can report and did not", () => {
    // The third silence, and the only one worth looking into. It used to fall
    // through with no label at all, so one timed-out poll took that machine's
    // whole set of features off the sky and out of every count without a word.
    const view = buildFeatureFlowView([
      environment({ environmentId: "env-mac", label: "mac", supported: true, pending: false }),
    ]);

    expect(view.unreadableLabels).toEqual(["mac"]);
    expect(view.unsupportedLabels).toEqual([]);
    expect(view.pendingLabels).toEqual([]);
  });

  it("attributes a project's diagnostics to the machine that reported them", () => {
    const view = buildFeatureFlowView([
      environment({
        environmentId: "env-mac",
        label: "mac",
        snapshot: snapshotFixture([
          {
            workspaceRoot: "/a/hub",
            title: "hub",
            features: [featureFixture("t-1", "in-progress")],
            diagnostics: ["not a git repository"],
          },
        ]),
      }),
    ]);

    expect(view.diagnostics).toEqual(["mac: not a git repository"]);
  });
});

describe("featureFlowStageProgress", () => {
  it("runs from nothing at the horizon to everything in production", () => {
    expect(featureFlowStageProgress("in-progress")).toBe(0);
    expect(featureFlowStageProgress("in-production")).toBe(1);
    expect(featureFlowStageProgress("in-dev")).toBeLessThan(featureFlowStageProgress("in-staging"));
  });
});

describe("diffFeatureStages", () => {
  it("reports nothing on first sight, so opening the Workbench is not a merge", () => {
    const { changed, stages } = diffFeatureStages(new Map(), [{ key: "a", stage: "in-dev" }]);
    expect([...changed]).toEqual([]);
    expect(stages.get("a")).toBe("in-dev");
  });

  it("reports work that rose to the next stage, and nothing that stayed put", () => {
    const previous = new Map<string, FeatureFlowStage>([
      ["a", "in-progress"],
      ["b", "in-dev"],
    ]);
    const { changed } = diffFeatureStages(previous, [
      { key: "a", stage: "in-dev" },
      { key: "b", stage: "in-dev" },
    ]);
    expect([...changed]).toEqual(["a"]);
  });
});
