/**
 * Fork-owned: a sky to look at while working on the sky.
 *
 * **Development only.** Reached by `?starmap-demo` and loaded through a dynamic
 * import behind an `import.meta.env.DEV` guard, so the module is not in a
 * production bundle at all — there is no runtime flag a user could find.
 *
 * It exists because the map cannot be judged empty. Every encoding it carries —
 * tier altitude, lineage branching, status colour, task-progress arcs, the
 * ghosts of a plan, the named degrade — needs work in several states with real
 * relationships between it, and producing that for real means paid turns on
 * four machines and branches merged into three trunks.
 *
 * Delete this file and the guard in `WorkbenchStarMap` and nothing else moves.
 */
import type { SkyFeature, SkyModel } from "./StarMap.model";

interface DemoFeature {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly stage: SkyFeature["stage"];
  readonly tone?: SkyFeature["tone"];
  readonly alive?: boolean;
  readonly settled?: boolean;
  readonly planned?: boolean;
  readonly stageReported?: boolean;
  readonly progress?: readonly [completed: number, total: number];
  readonly dependsOn?: string;
  readonly machine?: string;
  readonly project?: string;
  readonly authored?: boolean;
  readonly mergeability?: SkyFeature["mergeability"];
}

const feature = (input: DemoFeature): SkyFeature => ({
  key: input.id,
  name: input.name,
  description: input.description ?? null,
  stage: input.stage,
  stageReported: input.stageReported ?? true,
  threadRef:
    input.planned === true ? null : { environmentId: "env-mac", threadId: input.id.slice(0, 12) },
  machineLabel: input.planned === true ? null : (input.machine ?? "mac"),
  projectTitle: input.planned === true ? null : (input.project ?? "starcode"),
  tone: input.tone ?? "quiet",
  alive: input.alive ?? false,
  settled: input.settled ?? false,
  planned: input.planned ?? false,
  planSummary:
    input.progress === undefined
      ? null
      : { completed: input.progress[0], total: input.progress[1], activeStep: null },
  mergeability: input.mergeability ?? "unknown",
  dependsOnKeys: input.dependsOn === undefined ? [] : [input.dependsOn],
  masterAuthored: input.authored ?? false,
  lastActivityAt: "2026-07-25T10:00:00.000Z",
});

export function buildSkyDemoModel(): SkyModel {
  const features: ReadonlyArray<SkyFeature> = [
    // Shipped and settled work, high in the sky, still connected to the root it
    // grew from.
    feature({
      id: "a-brand",
      name: "starcode restyle",
      description: "Ink-and-butter palette across every surface.",
      stage: "in-production",
      tone: "done",
      settled: true,
      authored: true,
    }),
    feature({
      id: "b-sidebar",
      name: "Sidebar header",
      stage: "in-production",
      tone: "done",
      settled: true,
      dependsOn: "a-brand",
    }),
    feature({
      id: "c-rows",
      name: "Thread rows and task progress",
      stage: "in-staging",
      tone: "done",
      settled: true,
      dependsOn: "a-brand",
      mergeability: "ready",
    }),
    feature({
      id: "d-sky",
      name: "Living sky",
      description: "Drift, twinkle, and an hourly shooting star.",
      stage: "in-staging",
      tone: "done",
      settled: true,
      dependsOn: "a-brand",
      authored: true,
    }),

    // Landed work: in latest, not yet promoted further.
    feature({
      id: "e-history",
      name: "Terminal history reader",
      stage: "in-dev",
      tone: "done",
      settled: true,
      mergeability: "ready",
    }),
    feature({
      id: "f-connections",
      name: "Connections dropdown",
      description: "Health, ping, and spend per machine.",
      stage: "in-dev",
      tone: "done",
      settled: true,
      dependsOn: "e-history",
      authored: true,
      machine: "simforgelaptop",
    }),

    // In flight, branching off the root and off each other.
    feature({
      id: "g-starmap",
      name: "Workbench star map",
      description: "The sky itself: lineage, tiers, and the orchestrator's map.",
      stage: "in-progress",
      tone: "working",
      alive: true,
      progress: [5, 8],
      dependsOn: "d-sky",
      authored: true,
    }),
    feature({
      id: "h-import",
      name: "Conversation import",
      description: "Resume a terminal session as a thread.",
      stage: "in-progress",
      tone: "attention",
      progress: [6, 8],
      dependsOn: "e-history",
      mergeability: "blocked",
      authored: true,
    }),
    feature({
      id: "i-accounts",
      name: "Accounts and usage rework",
      stage: "in-progress",
      tone: "input",
      progress: [2, 5],
      machine: "simforge1",
      project: "starcode",
    }),
    feature({
      id: "j-actor",
      name: "Actor control overhaul",
      stage: "in-progress",
      tone: "working",
      alive: true,
      progress: [3, 11],
      machine: "simforgelaptop",
      project: "simcloud",
    }),
    feature({
      id: "k-timeline",
      name: "Behaviour timeline dock",
      stage: "in-progress",
      tone: "failed",
      dependsOn: "j-actor",
      machine: "simforgelaptop",
      project: "simcloud",
    }),
    feature({
      id: "l-exporter",
      name: "Export lane gating",
      stage: "in-progress",
      tone: "quiet",
      // Nothing could place this one, and the card says so.
      stageReported: false,
      machine: "path-pc",
      project: "alpamayo",
    }),

    // The plan: what the orchestrator intends, branching from real work.
    feature({
      id: "p-desktop",
      name: "Desktop rebuild pipeline",
      description: "One command from a landed change to an installed app.",
      stage: "in-progress",
      planned: true,
      dependsOn: "g-starmap",
    }),
    feature({
      id: "p-mobile",
      name: "Sky on mobile",
      description: "The same tree, one branch at a time.",
      stage: "in-progress",
      planned: true,
      dependsOn: "p-desktop",
    }),
    feature({
      id: "p-projects",
      name: "Projects as cross-machine categories",
      stage: "in-dev",
      planned: true,
      dependsOn: "f-connections",
    }),
  ];

  return {
    features: [...features].toSorted((left, right) => left.key.localeCompare(right.key)),
    master: {
      key: "env-mac:t-master",
      threadId: "t-master",
      environmentId: "env-mac",
      machineLabel: "mac",
      title: "Orchestrator",
      alive: true,
    },
    realCount: features.filter((entry) => !entry.planned).length,
    plannedCount: features.filter((entry) => entry.planned).length,
    stageUnsupportedLabels: ["path-pc"],
    diagnostics: [],
  };
}
