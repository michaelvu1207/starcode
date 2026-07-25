/**
 * Fork-owned: what the sky contains.
 *
 * One star is one piece of work. Two sources feed it and they answer different
 * questions, which is why both are needed:
 *
 *   - the thread shells every machine streams say what is *in flight* — the
 *     work that has a live status, a task list, someone waiting on it;
 *   - the feature-flow snapshot says where work has *reached* — the stage a
 *     piece of work has flowed into, and what it waits on.
 *
 * A machine that cannot report stages still contributes its in-flight work, so
 * the sky is never empty because one server is a release behind; its stars park
 * at the horizon and the map says so by name. A machine that is not connected
 * contributes nothing and is not named — it has not been asked, and blaming it
 * for the network would be a lie told four times a day.
 *
 * Work that has settled is on the map only when the flow snapshot places it:
 * a finished piece of work that landed in dev is worth seeing sit there, while
 * a finished thread nobody can place has nowhere honest to sit and belongs in
 * the sidebar's history rather than in the sky.
 */
import type { FeatureFlowMergeabilityState, FeatureFlowStage } from "@t3tools/contracts";
import type { OrchestrationThreadPlanSummary } from "@t3tools/contracts";

import type { FeatureFlowFeatureNode, FeatureFlowView } from "./FeatureFlow.model";
import type { WorkbenchBoard, WorkbenchBoardCard } from "./Workbench.board";
import { toneForPeerThreadStatus, toneForThreadStatus, type WorkbenchTone } from "./Workbench.tone";

export interface StarMapStar {
  /** `environmentId:threadId` — unique across machines. */
  readonly key: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly machineLabel: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly stage: FeatureFlowStage;
  /**
   * False when no machine could say where this work has reached. The star still
   * renders, at the horizon, and its card says the stage is unreported rather
   * than claiming it is in progress.
   */
  readonly stageReported: boolean;
  readonly tone: WorkbenchTone;
  /** A turn is running right now: the one thing on the map that pulses. */
  readonly alive: boolean;
  /** Work that has come to rest. Dimmer, and never animated. */
  readonly settled: boolean;
  readonly planSummary: OrchestrationThreadPlanSummary | null;
  readonly mergeability: FeatureFlowMergeabilityState;
  /** Started by the orchestrator, per its own transcript. */
  readonly masterCreated: boolean;
  readonly dependsOnKeys: ReadonlyArray<string>;
  readonly lastActivityAt: string;
}

export interface StarMapRegion {
  readonly environmentId: string;
  readonly label: string;
  readonly isLocal: boolean;
  readonly stars: ReadonlyArray<StarMapStar>;
}

export interface StarMapMaster {
  readonly key: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly machineLabel: string;
  readonly title: string;
  readonly alive: boolean;
}

export interface StarMapModel {
  readonly regions: ReadonlyArray<StarMapRegion>;
  readonly master: StarMapMaster | null;
  readonly starCount: number;
  /** Connected machines that cannot report stages, named once, plainly. */
  readonly stageUnsupportedLabels: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface StarMapModelInput {
  readonly board: WorkbenchBoard;
  readonly flow: FeatureFlowView;
  readonly master: StarMapMaster | null;
  /** `environmentId:projectId` → project title, for the hover card. */
  readonly projectTitleByKey: ReadonlyMap<string, string>;
}

const activityMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Whether a thread has a turn running.
 *
 * Derived from the same live session state the sidebar reads, never from
 * anything an agent says about itself.
 */
function isAlive(card: WorkbenchBoardCard): boolean {
  return card.status === "working";
}

function starFromCard(
  card: WorkbenchBoardCard,
  machineLabel: string,
  feature: FeatureFlowFeatureNode | undefined,
  projectTitleByKey: ReadonlyMap<string, string>,
): StarMapStar {
  const thread = card.thread;
  return {
    key: card.key,
    threadId: thread.id,
    environmentId: thread.environmentId,
    machineLabel,
    title: thread.title,
    projectTitle: projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
    stage: feature?.stage ?? "in-progress",
    stageReported: feature !== undefined,
    tone: toneForThreadStatus(card.status),
    alive: isAlive(card),
    settled: card.section === "settled",
    planSummary: thread.planSummary ?? feature?.planSummary ?? null,
    mergeability: feature?.mergeability.state ?? "unknown",
    masterCreated: card.masterCreated,
    dependsOnKeys: feature?.dependsOnKeys ?? [],
    lastActivityAt: thread.updatedAt,
  };
}

/**
 * A feature the shells did not carry — work that has landed and whose thread
 * has since settled out of the in-flight view. It keeps the stage the server
 * gave it, which is the entire reason it is worth drawing.
 */
function starFromFeature(feature: FeatureFlowFeatureNode): StarMapStar {
  return {
    key: feature.key,
    threadId: feature.threadId,
    environmentId: feature.environmentId,
    machineLabel: feature.environmentLabel,
    title: feature.title,
    projectTitle: null,
    stage: feature.stage,
    stageReported: true,
    tone: toneForPeerThreadStatus(feature.status),
    alive: feature.status === "working",
    settled: feature.status === "settled",
    planSummary: feature.planSummary,
    mergeability: feature.mergeability.state,
    masterCreated: false,
    dependsOnKeys: feature.dependsOnKeys,
    lastActivityAt: feature.lastActivityAt,
  };
}

/**
 * Composes the sky.
 *
 * Regions keep the board's machine order (local first, then by label) so the
 * sky does not rearrange itself when a machine reconnects — a map whose regions
 * swap places between visits is a map you have to re-read every time.
 */
export function buildStarMapModel(input: StarMapModelInput): StarMapModel {
  const featuresByKey = new Map(input.flow.features.map((feature) => [feature.key, feature]));
  const claimed = new Set<string>();

  const regions: StarMapRegion[] = [];
  let starCount = 0;

  for (const group of input.board.groups) {
    const stars: StarMapStar[] = [];
    for (const card of group.cards) {
      const feature = featuresByKey.get(card.key);
      // A settled thread the flow snapshot cannot place has no stage to sit in.
      if (card.section === "settled" && feature === undefined) continue;
      if (feature !== undefined) claimed.add(card.key);
      stars.push(starFromCard(card, group.label, feature, input.projectTitleByKey));
    }
    for (const feature of input.flow.features) {
      if (feature.environmentId !== group.environmentId) continue;
      if (claimed.has(feature.key)) continue;
      claimed.add(feature.key);
      stars.push(starFromFeature(feature));
    }
    if (stars.length === 0) continue;

    // Sorted by key rather than by activity: position must depend on which
    // stars are in the sky, never on the order they last moved, or the field
    // shuffles itself every time a turn completes.
    stars.sort((left, right) => left.key.localeCompare(right.key));
    starCount += stars.length;
    regions.push({
      environmentId: group.environmentId,
      label: group.label,
      isLocal: group.isLocal,
      stars,
    });
  }

  return {
    regions,
    master: input.master,
    starCount,
    stageUnsupportedLabels: input.flow.unsupportedLabels,
    diagnostics: input.flow.diagnostics,
  };
}

/** The most recently touched star, for describing an otherwise silent sky. */
export function latestStar(model: StarMapModel): StarMapStar | null {
  let latest: StarMapStar | null = null;
  for (const region of model.regions) {
    for (const star of region.stars) {
      if (latest === null || activityMs(star.lastActivityAt) > activityMs(latest.lastActivityAt)) {
        latest = star;
      }
    }
  }
  return latest;
}
