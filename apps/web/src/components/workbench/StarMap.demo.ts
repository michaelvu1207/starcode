/**
 * Fork-owned: a sky to look at while working on the sky.
 *
 * **Development only.** Reached by `?starmap-demo` and loaded through a dynamic
 * import behind an `import.meta.env.DEV` guard, so the module is not in a
 * production bundle at all — there is no runtime flag a user could find.
 *
 * It exists because the map cannot be judged empty. Every encoding it carries —
 * stage altitude, machine regions, status colour, task-progress arcs, the
 * dependency connectors, the settled dimming, the named degrade — needs work in
 * several states across several machines to be visible, and producing that for
 * real means paid turns on four machines and branches merged into three trunks.
 * A fixture makes the thing reviewable and screenshot-able; the same argument
 * the sky's own meteor-shower flag is built on.
 *
 * Delete this file and the guard in `WorkbenchStarMap` and nothing else moves.
 */
import type { StarMapModel, StarMapRegion, StarMapStar } from "./StarMap.model";

interface DemoStar {
  readonly id: string;
  readonly title: string;
  readonly stage: StarMapStar["stage"];
  readonly tone: StarMapStar["tone"];
  readonly alive?: boolean;
  readonly settled?: boolean;
  readonly stageReported?: boolean;
  readonly progress?: readonly [completed: number, total: number];
  readonly dependsOn?: ReadonlyArray<string>;
  readonly masterCreated?: boolean;
  readonly mergeability?: StarMapStar["mergeability"];
}

function region(
  environmentId: string,
  label: string,
  isLocal: boolean,
  project: string,
  stars: ReadonlyArray<DemoStar>,
): StarMapRegion {
  return {
    environmentId,
    label,
    isLocal,
    stars: stars
      .map(
        (star): StarMapStar => ({
          key: `${environmentId}:${star.id}`,
          threadId: star.id,
          environmentId,
          machineLabel: label,
          title: star.title,
          projectTitle: project,
          stage: star.stage,
          stageReported: star.stageReported ?? true,
          tone: star.tone,
          alive: star.alive ?? false,
          settled: star.settled ?? false,
          planSummary:
            star.progress === undefined
              ? null
              : { completed: star.progress[0], total: star.progress[1], activeStep: null },
          mergeability: star.mergeability ?? "unknown",
          masterCreated: star.masterCreated ?? false,
          dependsOnKeys: (star.dependsOn ?? []).map((id) => `${environmentId}:${id}`),
          lastActivityAt: "2026-07-25T10:00:00.000Z",
        }),
      )
      .toSorted((left, right) => left.key.localeCompare(right.key)),
  };
}

export function buildStarMapDemoModel(): StarMapModel {
  const regions = [
    region("env-mac", "mac", true, "starcode", [
      {
        id: "t-sky",
        title: "Workbench star map",
        stage: "in-progress",
        tone: "working",
        alive: true,
        progress: [4, 7],
        masterCreated: true,
      },
      {
        id: "t-import",
        title: "Conversation import",
        stage: "in-progress",
        tone: "attention",
        progress: [6, 8],
        dependsOn: ["t-history"],
        mergeability: "blocked",
      },
      {
        id: "t-history",
        title: "Terminal history reader",
        stage: "in-dev",
        tone: "done",
        settled: true,
        mergeability: "ready",
      },
      {
        id: "t-connections",
        title: "Connections dropdown",
        stage: "in-progress",
        tone: "input",
        progress: [2, 5],
        masterCreated: true,
      },
      {
        id: "t-rows",
        title: "Thread row cleanup",
        stage: "in-staging",
        tone: "done",
        settled: true,
      },
      {
        id: "t-brand",
        title: "starcode restyle",
        stage: "in-production",
        tone: "done",
        settled: true,
      },
      {
        id: "t-sidebar",
        title: "Sidebar header",
        stage: "in-production",
        tone: "done",
        settled: true,
      },
    ]),
    region("env-laptop", "simforgelaptop", false, "simcloud", [
      {
        id: "t-actor",
        title: "Actor control overhaul",
        stage: "in-progress",
        tone: "working",
        alive: true,
        progress: [3, 11],
      },
      {
        id: "t-timeline",
        title: "Behaviour timeline dock",
        stage: "in-progress",
        tone: "failed",
        dependsOn: ["t-actor"],
      },
      {
        id: "t-editor",
        title: "Scenario editor map load",
        stage: "in-dev",
        tone: "done",
        settled: true,
      },
      {
        id: "t-routes",
        title: "Dead route cleanup",
        stage: "in-staging",
        tone: "done",
        settled: true,
      },
    ]),
    region("env-simforge1", "simforge1", false, "alpamayo", [
      {
        id: "t-trainer",
        title: "Trainer smoke harness",
        stage: "in-progress",
        tone: "working",
        alive: true,
        progress: [9, 12],
      },
      {
        id: "t-exporter",
        title: "Export lane gating",
        stage: "in-progress",
        tone: "quiet",
        // Reported by no machine: parked at the horizon and honest about it.
        stageReported: false,
      },
      {
        id: "t-eval",
        title: "Eval harness protocol v1",
        stage: "in-dev",
        tone: "done",
        settled: true,
        mergeability: "ready",
      },
      {
        id: "t-fleet",
        title: "Render fleet sizing",
        stage: "in-production",
        tone: "done",
        settled: true,
      },
    ]),
    region("env-pathpc", "path-pc", false, "v2x", [
      {
        id: "t-bridge",
        title: "Drive bridge tunnel",
        stage: "in-progress",
        tone: "attention",
        progress: [1, 4],
      },
      { id: "t-sim", title: "Local simulator refresh", stage: "in-progress", tone: "quiet" },
    ]),
  ];

  return {
    regions,
    master: {
      key: "env-mac:t-master",
      threadId: "t-master",
      environmentId: "env-mac",
      machineLabel: "mac",
      title: "Orchestrator",
      alive: true,
    },
    starCount: regions.reduce((total, entry) => total + entry.stars.length, 0),
    stageUnsupportedLabels: ["path-pc"],
    diagnostics: [],
  };
}
