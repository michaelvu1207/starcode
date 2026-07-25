/**
 * Pure rules for the feature map.
 *
 * Everything here is a decision about the shape of the map — what a promotion
 * advances to, whether a link would close a loop, what a plan replaces. Kept
 * out of the registry so the awkward parts are testable without a filesystem,
 * and so the one genuinely dangerous operation (plan replacement) is a function
 * you can read in full.
 *
 * @module FeatureMapLogic
 */
import {
  FeatureFlowStage,
  type FeatureMapEntry,
  type FeatureMapEntryId,
  type FeaturePlanEntry,
} from "@t3tools/contracts";

/** Ordered, lowest first. The same order the sky reads bottom to top. */
export const FEATURE_STAGE_ORDER = [
  "in-progress",
  "in-dev",
  "in-staging",
  "in-production",
] as const satisfies ReadonlyArray<FeatureFlowStage>;

export const stageRank = (stage: FeatureFlowStage): number => {
  const index = FEATURE_STAGE_ORDER.indexOf(stage);
  return index === -1 ? 0 : index;
};

/**
 * The stage a promotion lands on, or null when there is nowhere further to go.
 *
 * Null rather than a silent no-op: an agent that promotes something already
 * shipped has misread the map, and telling it so is cheaper than letting it
 * believe it moved something.
 */
export const nextStage = (stage: FeatureFlowStage): FeatureFlowStage | null => {
  const rank = stageRank(stage);
  return rank >= FEATURE_STAGE_ORDER.length - 1 ? null : FEATURE_STAGE_ORDER[rank + 1]!;
};

/**
 * Whether adding `id → dependsOnId` would close a loop.
 *
 * A cycle in the map is not a cosmetic problem: the sky lays features out as a
 * tree rooted at the shared start, and a loop has no root, so the layout would
 * have to either drop an edge silently or not terminate. Refusing the write is
 * the only place this can be handled honestly.
 */
export function wouldCycle(
  entries: ReadonlyArray<FeatureMapEntry>,
  id: FeatureMapEntryId,
  dependsOnId: FeatureMapEntryId,
): boolean {
  if (id === dependsOnId) return true;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const stack: FeatureMapEntryId[] = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === id) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of byId.get(current)?.dependsOn ?? []) stack.push(next);
  }
  return false;
}

/**
 * Drops links pointing at entries that are no longer there.
 *
 * Called after a plan replacement, which is the one operation that can delete
 * an entry something else still names. A dangling id would otherwise sit in the
 * file forever and read on the client as a dependency on nothing.
 */
export function pruneDanglingLinks(
  entries: ReadonlyArray<FeatureMapEntry>,
): ReadonlyArray<FeatureMapEntry> {
  const present = new Set(entries.map((entry) => entry.id));
  return entries.map((entry) => {
    const kept = entry.dependsOn.filter((id) => present.has(id));
    return kept.length === entry.dependsOn.length ? entry : { ...entry, dependsOn: kept };
  });
}

export interface PlanResolution {
  /** The planned entries the plan describes, in the order it gave them. */
  readonly entries: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly stage: FeatureFlowStage;
    readonly dependsOnKeys: ReadonlyArray<string>;
  }>;
}

/**
 * Normalises a plan into entries with resolvable local links.
 *
 * `dependsOn` names other entries by their caller-local `key`. Keys that do not
 * appear in the same call are dropped rather than rejected: a plan is a sketch,
 * and refusing the whole write because one step referenced something the author
 * decided not to include would make the tool hostile to the way plans are
 * actually written.
 */
export function resolvePlan(features: ReadonlyArray<FeaturePlanEntry>): PlanResolution {
  const keys = new Set(features.map((feature) => feature.key));
  return {
    entries: features.map((feature) => ({
      key: feature.key,
      name: feature.name,
      description: feature.description ?? null,
      stage: feature.stage ?? "in-progress",
      dependsOnKeys: (feature.dependsOn ?? []).filter(
        (key) => keys.has(key) && key !== feature.key,
      ),
    })),
  };
}
