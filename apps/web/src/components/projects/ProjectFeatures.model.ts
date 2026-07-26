/**
 * Fork-owned: one project's features, gathered from every machine that holds
 * any.
 *
 * Feature *flow* has folded across machines since it existed. The feature
 * *map* did not: there is one registry file per server, and `project_get`
 * answers only about the machine it runs on — deliberately, because a tool
 * result that claimed to know what another machine holds would be inventing.
 * The consequence was that an orchestrator on the Mac could create a feature on
 * simforge1 and then have nowhere to read it back.
 *
 * The union is therefore the client's job, and this is it. Two properties are
 * worth stating because both are easy to get wrong:
 *
 * 1. **Nothing is merged.** Two machines holding an entry of the same name are
 *    two features. Collapsing them would be the client guessing that two
 *    independently authored rows are the same work, and a wrong guess silently
 *    hides one of them. Keys stay namespaced by machine, exactly as on the sky.
 * 2. **Membership is not re-derived here.** Which features belong to the
 *    project is `featureMapEntryInProject`, the same rule the server's
 *    `project_get` and the sky use. A third implementation of that would be a
 *    bug by construction.
 *
 * @module ProjectFeaturesModel
 */
import type { FeatureFlowStage, FeatureMapEntry, ThreadId } from "@t3tools/contracts";
import { featureMapEntryInProject } from "@t3tools/contracts";

import type { SkyMachineMap, SkyProjectScope } from "../workbench/StarMap.model";

/** One feature, and the machine whose registry it came out of. */
export interface FoldedProjectFeature {
  /** `map:<environmentId>:<entryId}` — the same key the sky seeds stars from. */
  readonly key: string;
  readonly environmentId: string;
  readonly machineLabel: string;
  readonly entry: FeatureMapEntry;
}

/** How many of this project's features one machine carries. */
export interface ProjectFeatureMachineCount {
  readonly environmentId: string;
  readonly label: string;
  readonly count: number;
}

export interface ProjectFeatureRollup {
  readonly features: ReadonlyArray<FoldedProjectFeature>;
  /** Work under way, on any machine. */
  readonly realCount: number;
  /** Intent, on any machine. */
  readonly plannedCount: number;
  /** Real features per stage, lowest stage first. Planned ones are excluded —
      a ghost has not reached a stage, it has been given one. */
  readonly byStage: ReadonlyArray<{ readonly stage: FeatureFlowStage; readonly count: number }>;
  /** One entry per machine that carries any, ordered by label. */
  readonly machines: ReadonlyArray<ProjectFeatureMachineCount>;
}

/** Lowest first — the order the sky reads bottom to top. */
const STAGE_ORDER = [
  "in-progress",
  "in-dev",
  "in-staging",
  "in-production",
] as const satisfies ReadonlyArray<FeatureFlowStage>;

export const PROJECT_FEATURE_STAGE_LABEL: Record<FeatureFlowStage, string> = {
  "in-progress": "in flight",
  "in-dev": "landed",
  "in-staging": "ready",
  "in-production": "shipped",
};

const EMPTY: ProjectFeatureRollup = {
  features: [],
  realCount: 0,
  plannedCount: 0,
  byStage: [],
  machines: [],
};

/**
 * Every machine's answer about one project, unioned.
 *
 * Order-independent by construction: features sort by key and machines by
 * label, so feeding the same machines in a different order produces the
 * identical rollup. That is the property that makes this testable at all, and
 * it is the same discipline `buildProjectCatalogView` follows one file over.
 */
export function foldProjectFeatures(input: {
  readonly mapEntriesByEnvironment: ReadonlyMap<string, SkyMachineMap>;
  readonly scope: SkyProjectScope;
}): ProjectFeatureRollup {
  const features: Array<FoldedProjectFeature> = [];
  const machines = new Map<string, ProjectFeatureMachineCount>();

  for (const [environmentId, machine] of input.mapEntriesByEnvironment) {
    for (const entry of machine.entries) {
      const belongs = featureMapEntryInProject(entry, input.scope.slug, (threadId: ThreadId) =>
        input.scope.includeThreadKey(`${environmentId}:${threadId}`),
      );
      if (!belongs) continue;
      features.push({
        key: `map:${environmentId}:${entry.id}`,
        environmentId,
        machineLabel: machine.label,
        entry,
      });
      const counted = machines.get(environmentId);
      if (counted === undefined) {
        machines.set(environmentId, { environmentId, label: machine.label, count: 1 });
      } else {
        machines.set(environmentId, { ...counted, count: counted.count + 1 });
      }
    }
  }

  if (features.length === 0) return EMPTY;

  const stageCounts = new Map<FeatureFlowStage, number>();
  let plannedCount = 0;
  for (const folded of features) {
    if (folded.entry.planned) {
      plannedCount += 1;
      continue;
    }
    stageCounts.set(folded.entry.stage, (stageCounts.get(folded.entry.stage) ?? 0) + 1);
  }

  return {
    features: features.toSorted((left, right) => left.key.localeCompare(right.key)),
    realCount: features.length - plannedCount,
    plannedCount,
    byStage: STAGE_ORDER.flatMap((stage) => {
      const count = stageCounts.get(stage);
      return count === undefined ? [] : [{ stage, count }];
    }),
    machines: [...machines.values()].toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.environmentId.localeCompare(right.environmentId),
    ),
  };
}

/**
 * The rollup as one line of prose, or null when there is nothing to say.
 *
 * Prose rather than a row of badges because this sits beside the sky, and the
 * sky is already the picture. A second, smaller picture of the same thing would
 * compete with it; a sentence does not.
 */
export function describeProjectFeatures(rollup: ProjectFeatureRollup): string | null {
  if (rollup.features.length === 0) return null;
  const parts: Array<string> = [
    `${rollup.realCount} feature${rollup.realCount === 1 ? "" : "s"}`,
  ];
  for (const { stage, count } of rollup.byStage) {
    parts.push(`${count} ${PROJECT_FEATURE_STAGE_LABEL[stage]}`);
  }
  if (rollup.plannedCount > 0) parts.push(`${rollup.plannedCount} planned`);
  return parts.join(" · ");
}
