/**
 * Fork-owned: what the sky contains.
 *
 * One star is one feature, and the sky is deliberately **independent of
 * connections**. Which machine happens to be running a piece of work is a fact
 * about today's fleet, not a fact about the work, and turning it into geography
 * made the map answer a question nobody was asking. The machine survives as a
 * line on the hover card and nowhere else.
 *
 * Three sources feed one list:
 *
 *   - **thread shells** say what is in flight — live status, task lists, who is
 *     waiting on what right now;
 *   - **the feature-flow snapshot** says where work has reached, computed from
 *     the repository;
 *   - **the feature map** is what the orchestrator says, written through its
 *     tools: real names, descriptions, promotions it performed, links it drew,
 *     and features that exist only as intent.
 *
 * Where the map and the derived flow disagree, the map wins for the fields it
 * authors. It was written by something that knows why the work exists; the
 * repository only knows what landed, and it finds out later.
 */
import type {
  FeatureFlowMergeabilityState,
  FeatureFlowStage,
  FeatureMapEntry,
  OrchestrationThreadPlanSummary,
} from "@t3tools/contracts";

import type { FeatureFlowFeatureNode, FeatureFlowView } from "./FeatureFlow.model";
import type { WorkbenchBoard, WorkbenchBoardCard } from "./Workbench.board";
import { toneForPeerThreadStatus, toneForThreadStatus, type WorkbenchTone } from "./Workbench.tone";

export interface SkyThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface SkyFeature {
  /** Stable across reloads and across machines. Seeds the star's position. */
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly stage: FeatureFlowStage;
  /**
   * False when nothing could say where this has reached — no repository answer
   * and no promotion. The star sits at the first tier and its card says so
   * rather than claiming the work is under way.
   */
  readonly stageReported: boolean;
  /** Null for a feature nobody has started yet. */
  readonly threadRef: SkyThreadRef | null;
  /** Hover-card detail only. Never geography. */
  readonly machineLabel: string | null;
  readonly projectTitle: string | null;
  readonly tone: WorkbenchTone;
  /** A turn is running: the one thing on the map that pulses. */
  readonly alive: boolean;
  readonly settled: boolean;
  /** Intent rather than work. Renders as a ghost beside the lit stars. */
  readonly planned: boolean;
  readonly planSummary: OrchestrationThreadPlanSummary | null;
  readonly mergeability: FeatureFlowMergeabilityState;
  /** Features this one branches from. Empty means it branches off the origin. */
  readonly dependsOnKeys: ReadonlyArray<string>;
  /** The orchestrator wrote this entry, rather than it being derived. */
  readonly masterAuthored: boolean;
  readonly lastActivityAt: string;
}

export interface SkyMaster {
  readonly key: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly machineLabel: string;
  readonly title: string;
  readonly alive: boolean;
}

export interface SkyModel {
  readonly features: ReadonlyArray<SkyFeature>;
  readonly master: SkyMaster | null;
  readonly realCount: number;
  readonly plannedCount: number;
  /** Connected machines that cannot report stages, named once, plainly. */
  readonly stageUnsupportedLabels: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface SkyMachineMap {
  readonly label: string;
  readonly entries: ReadonlyArray<FeatureMapEntry>;
}

export interface SkyModelInput {
  readonly board: WorkbenchBoard;
  readonly flow: FeatureFlowView;
  /** Each machine's own registry, keyed by the machine that served it. */
  readonly mapEntriesByEnvironment: ReadonlyMap<string, SkyMachineMap>;
  readonly master: SkyMaster | null;
  /** `environmentId:projectId` → project title, for the hover card. */
  readonly projectTitleByKey: ReadonlyMap<string, string>;
}

const threadKey = (environmentId: string, threadId: string): string =>
  `${environmentId}:${threadId}`;

/**
 * Registry keys are namespaced by machine as well as by entry id.
 *
 * A registry is per-server: the orchestrator writes to the machine it runs on,
 * and every machine can hold one. Two of them minting the same twelve hex
 * characters is unlikely and would be silent, which is the combination worth
 * one prefix.
 */
const mapKey = (environmentId: string, entryId: string): string =>
  `map:${environmentId}:${entryId}`;

const activityMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

interface ThreadFacts {
  readonly threadRef: SkyThreadRef;
  readonly machineLabel: string;
  readonly projectTitle: string | null;
  readonly title: string;
  readonly tone: WorkbenchTone;
  readonly alive: boolean;
  readonly settled: boolean;
  readonly planSummary: OrchestrationThreadPlanSummary | null;
  readonly lastActivityAt: string;
}

function factsFromCard(
  card: WorkbenchBoardCard,
  machineLabel: string,
  projectTitleByKey: ReadonlyMap<string, string>,
): ThreadFacts {
  const thread = card.thread;
  return {
    threadRef: { environmentId: thread.environmentId, threadId: thread.id },
    machineLabel,
    projectTitle: projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
    title: thread.title,
    tone: toneForThreadStatus(card.status),
    alive: card.status === "working",
    settled: card.section === "settled",
    planSummary: thread.planSummary ?? null,
    lastActivityAt: thread.updatedAt,
  };
}

function factsFromFeature(feature: FeatureFlowFeatureNode): ThreadFacts {
  return {
    threadRef: { environmentId: feature.environmentId, threadId: feature.threadId },
    machineLabel: feature.environmentLabel,
    projectTitle: null,
    title: feature.title,
    tone: toneForPeerThreadStatus(feature.status),
    alive: feature.status === "working",
    settled: feature.status === "settled",
    planSummary: feature.planSummary,
    lastActivityAt: feature.lastActivityAt,
  };
}

/**
 * Composes the sky.
 *
 * The output is one flat list. Ordering is by key rather than by activity, for
 * the same reason positions are seeded rather than random: the shape of the
 * tree must not change because a turn finished somewhere.
 */
export function buildSkyModel(input: SkyModelInput): SkyModel {
  const featuresByKey = new Map(input.flow.features.map((feature) => [feature.key, feature]));

  // 1. Everything with a thread behind it, from either source, keyed by thread.
  const threadFacts = new Map<string, ThreadFacts>();
  const derivedStage = new Map<string, FeatureFlowStage>();
  const derivedDependsOn = new Map<string, ReadonlyArray<string>>();
  const derivedMergeability = new Map<string, FeatureFlowMergeabilityState>();

  for (const group of input.board.groups) {
    for (const card of group.cards) {
      const feature = featuresByKey.get(card.key);
      // A settled thread nothing can place has no honest tier to sit in.
      if (card.section === "settled" && feature === undefined) continue;
      threadFacts.set(card.key, factsFromCard(card, group.label, input.projectTitleByKey));
    }
  }
  for (const feature of input.flow.features) {
    if (!threadFacts.has(feature.key)) threadFacts.set(feature.key, factsFromFeature(feature));
    derivedStage.set(feature.key, feature.stage);
    derivedDependsOn.set(feature.key, feature.dependsOnKeys);
    derivedMergeability.set(feature.key, feature.mergeability.state);
  }

  // 2. The orchestrator's entries, which claim threads and add features of
  //    their own.
  const claimedThreadKey = new Map<string, string>();
  const built: SkyFeature[] = [];

  for (const [environmentId, machine] of input.mapEntriesByEnvironment) {
    for (const entry of machine.entries) {
      const key = mapKey(environmentId, entry.id);
      const boundKey = entry.threadId === null ? null : threadKey(environmentId, entry.threadId);
      const facts = boundKey === null ? undefined : threadFacts.get(boundKey);
      if (boundKey !== null) claimedThreadKey.set(boundKey, key);

      built.push({
        key,
        name: entry.name,
        description: entry.description,
        // The promotion the orchestrator performed outranks what the
        // repository has noticed so far.
        stage: entry.stage,
        stageReported: true,
        threadRef: facts?.threadRef ?? null,
        machineLabel: facts?.machineLabel ?? machine.label,
        projectTitle: facts?.projectTitle ?? null,
        tone: entry.planned ? "quiet" : (facts?.tone ?? "quiet"),
        alive: facts?.alive ?? false,
        settled: facts?.settled ?? false,
        planned: entry.planned,
        planSummary: facts?.planSummary ?? null,
        mergeability:
          boundKey === null ? "unknown" : (derivedMergeability.get(boundKey) ?? "unknown"),
        dependsOnKeys: entry.dependsOn.map((id) => mapKey(environmentId, id)),
        masterAuthored: true,
        lastActivityAt: facts?.lastActivityAt ?? entry.updatedAt,
      });
    }
  }

  // 3. Work nobody has written down yet still belongs on the sky.
  for (const [key, facts] of threadFacts) {
    if (claimedThreadKey.has(key)) continue;
    const stage = derivedStage.get(key);
    built.push({
      key,
      name: facts.title,
      description: null,
      stage: stage ?? "in-progress",
      stageReported: stage !== undefined,
      threadRef: facts.threadRef,
      machineLabel: facts.machineLabel,
      projectTitle: facts.projectTitle,
      tone: facts.tone,
      alive: facts.alive,
      settled: facts.settled,
      planned: false,
      planSummary: facts.planSummary,
      mergeability: derivedMergeability.get(key) ?? "unknown",
      dependsOnKeys: derivedDependsOn.get(key) ?? [],
      masterAuthored: false,
      lastActivityAt: facts.lastActivityAt,
    });
  }

  // 4. Redirect derived links through whatever claimed their thread, then drop
  //    anything pointing off the sky: a link to a feature that is not drawn is
  //    a branch from nothing.
  const present = new Set(built.map((feature) => feature.key));
  const features = built
    .map((feature): SkyFeature => {
      const resolved = feature.dependsOnKeys
        .map((key) => claimedThreadKey.get(key) ?? key)
        .filter((key, index, all) => key !== feature.key && all.indexOf(key) === index)
        .filter((key) => present.has(key));
      const unchanged =
        resolved.length === feature.dependsOnKeys.length &&
        resolved.every((key, index) => key === feature.dependsOnKeys[index]);
      return unchanged ? feature : { ...feature, dependsOnKeys: resolved };
    })
    .toSorted((left, right) => left.key.localeCompare(right.key));

  return {
    features,
    master: input.master,
    realCount: features.filter((feature) => !feature.planned).length,
    plannedCount: features.filter((feature) => feature.planned).length,
    stageUnsupportedLabels: input.flow.unsupportedLabels,
    diagnostics: input.flow.diagnostics,
  };
}

/** The most recently touched feature, for describing an otherwise silent sky. */
export function latestFeature(model: SkyModel): SkyFeature | null {
  let latest: SkyFeature | null = null;
  for (const feature of model.features) {
    if (feature.planned) continue;
    if (latest === null || activityMs(feature.lastActivityAt) > activityMs(latest.lastActivityAt)) {
      latest = feature;
    }
  }
  return latest;
}
