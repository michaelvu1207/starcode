/**
 * Fork-owned: what each machine says about the work it is carrying.
 *
 * The panel this once fed drew lanes; the Workbench draws a sky now, so the
 * geometry that lived here has moved to `StarMap.layout` and what remains is
 * the data fold: every machine's answer, flattened into one list of features
 * that the map can place.
 *
 * The vocabulary boundary is unchanged and load-bearing. Branch containment,
 * ahead/behind counts and pull requests exist on the wire because the server
 * needed them to decide which stage a feature has reached. Nothing below this
 * line carries them any further: a feature has a name, a stage, a machine and a
 * readiness state, and that is the whole of what the UI is allowed to know.
 */
import type {
  FeatureFlowFeature,
  FeatureFlowSnapshot,
  FeatureFlowStage,
  FeatureFlowMergeability,
  OrchestrationThreadPlanSummary,
  PeerThreadStatus,
} from "@starcode/contracts";

/** The order work flows. Index is the stage's height in the sky. */
export const FEATURE_FLOW_STAGES = [
  "in-progress",
  "in-dev",
  "in-staging",
  "in-production",
] as const satisfies ReadonlyArray<FeatureFlowStage>;

export const FEATURE_FLOW_STAGE_LABELS: Readonly<Record<FeatureFlowStage, string>> = {
  "in-progress": "In progress",
  "in-dev": "dev",
  "in-staging": "staging",
  "in-production": "production",
};

export interface FeatureFlowFeatureNode {
  /** Unique across machines: two servers can hold threads with the same id. */
  readonly key: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly title: string;
  readonly status: PeerThreadStatus;
  readonly stage: FeatureFlowStage;
  readonly planSummary: OrchestrationThreadPlanSummary | null;
  readonly mergeability: FeatureFlowMergeability;
  /** Keys of features this one waits on, already narrowed to features in view. */
  readonly dependsOnKeys: ReadonlyArray<string>;
  readonly lastActivityAt: string;
}

export interface FeatureFlowEnvironmentInput {
  readonly environmentId: string;
  readonly label: string;
  readonly snapshot: FeatureFlowSnapshot | null;
  /** False once the machine has answered and could not serve the route. */
  readonly supported: boolean;
  readonly pending: boolean;
}

export interface FeatureFlowView {
  readonly features: ReadonlyArray<FeatureFlowFeatureNode>;
  /** Machines whose server cannot report stages, named so the gap is visible. */
  readonly unsupportedLabels: ReadonlyArray<string>;
  readonly pendingLabels: ReadonlyArray<string>;
  /**
   * Machines that are connected, claim the capability, and still did not
   * answer. The only one of the three silences worth looking into, and the one
   * that used to be invisible.
   */
  readonly unreadableLabels: ReadonlyArray<string>;
  /** Machine-attributed reasons a project could not be read. */
  readonly diagnostics: ReadonlyArray<string>;
}

export interface FeatureFlowViewOptions {
  /**
   * The orchestrator's key. It is a thread with a branch like any other, so the
   * server reports it as a feature — but it is the thing directing the work,
   * not one of the pieces of work, and placing it among them makes the map
   * claim something it does not mean.
   */
  readonly excludeThreadKey?: string | null;
  /**
   * Membership test, for a sky scoped to one project rather than to the fleet.
   *
   * Optional and defaulting to "everything", so `/workbench` keeps its current
   * behaviour byte for byte. A predicate rather than a set of keys because the
   * caller resolving membership (the project catalog fold) already holds the
   * answer and should not have to materialise a second collection to pass it.
   */
  readonly includeThreadKey?: ((key: string) => boolean) | null;
}

export const featureFlowKey = (environmentId: string, threadId: string): string =>
  `${environmentId}:${threadId}`;

function collect(
  environment: FeatureFlowEnvironmentInput,
  feature: FeatureFlowFeature,
): { node: FeatureFlowFeatureNode; dependsOnThreadIds: ReadonlyArray<string> } {
  return {
    node: {
      key: featureFlowKey(environment.environmentId, feature.threadId),
      threadId: feature.threadId,
      environmentId: environment.environmentId,
      environmentLabel: environment.label,
      title: feature.title,
      status: feature.status,
      stage: feature.stage,
      planSummary: feature.planSummary,
      mergeability: feature.mergeability,
      dependsOnKeys: [],
      lastActivityAt: feature.lastActivityAt,
    },
    dependsOnThreadIds: feature.dependsOn.map((dependency) => dependency.dependsOnThreadId),
  };
}

/**
 * Folds every machine's answer into one list of features.
 *
 * Dependencies resolve within a machine only. The server infers them from one
 * repository's history, so a dependency id from machine A means nothing on
 * machine B — resolving across machines would invent edges out of colliding
 * ids.
 */
export function buildFeatureFlowView(
  environments: ReadonlyArray<FeatureFlowEnvironmentInput>,
  options?: FeatureFlowViewOptions,
): FeatureFlowView {
  const collected: Array<{
    node: FeatureFlowFeatureNode;
    dependsOnThreadIds: ReadonlyArray<string>;
  }> = [];
  const unsupportedLabels: string[] = [];
  const pendingLabels: string[] = [];
  const unreadableLabels: string[] = [];
  const diagnostics: string[] = [];

  for (const environment of environments) {
    if (environment.snapshot === null) {
      // Three different silences, and the view has to say which — the same
      // three the project catalog's fold names. The third was missing here: a
      // machine that is connected *and* advertises the capability and still did
      // not answer used to fall through with no label at all, so a single
      // timed-out poll (the route shells out to git per project) took that
      // machine's whole set of features off the sky and out of every count,
      // silently. Silence about a machine you are connected to is the one
      // answer this must never give.
      if (environment.pending) pendingLabels.push(environment.label);
      else if (!environment.supported) unsupportedLabels.push(environment.label);
      else unreadableLabels.push(environment.label);
      continue;
    }
    for (const project of environment.snapshot.projects) {
      for (const feature of project.features) {
        const key = featureFlowKey(environment.environmentId, feature.threadId);
        if (key === options?.excludeThreadKey) continue;
        if (options?.includeThreadKey != null && !options.includeThreadKey(key)) continue;
        collected.push(collect(environment, feature));
      }
      for (const diagnostic of project.diagnostics) {
        // Attributed, because "not a git repository" is only actionable if you
        // know which machine is saying it.
        const attributed = `${environment.label}: ${diagnostic}`;
        if (!diagnostics.includes(attributed)) diagnostics.push(attributed);
      }
    }
  }

  const keysInView = new Set(collected.map((entry) => entry.node.key));
  const features = collected.map((entry): FeatureFlowFeatureNode => {
    const dependsOnKeys = entry.dependsOnThreadIds
      .map((threadId) => featureFlowKey(entry.node.environmentId, threadId))
      .filter((key) => keysInView.has(key) && key !== entry.node.key);
    return { ...entry.node, dependsOnKeys };
  });

  return { features, unsupportedLabels, pendingLabels, unreadableLabels, diagnostics };
}

/** Ordered stage progression, for reading "how far has this got" without git. */
export function featureFlowStageProgress(stage: FeatureFlowStage): number {
  const index = FEATURE_FLOW_STAGES.indexOf(stage);
  const rank = index === -1 ? FEATURE_FLOW_STAGES.length : index;
  return rank / (FEATURE_FLOW_STAGES.length - 1);
}

/**
 * Which features changed stage since the last render, so the map can mark them
 * as they rise. Returns the next stage map alongside, because the caller must
 * store exactly what was compared against.
 */
export function diffFeatureStages(
  previous: ReadonlyMap<string, FeatureFlowStage>,
  features: ReadonlyArray<{ readonly key: string; readonly stage: FeatureFlowStage }>,
): {
  readonly changed: ReadonlySet<string>;
  readonly stages: ReadonlyMap<string, FeatureFlowStage>;
} {
  const stages = new Map<string, FeatureFlowStage>();
  const changed = new Set<string>();
  for (const feature of features) {
    stages.set(feature.key, feature.stage);
    const before = previous.get(feature.key);
    // A feature seen for the first time has not moved: it appeared. Marking it
    // would make every visit to the Workbench look like a merge just happened.
    if (before !== undefined && before !== feature.stage) changed.add(feature.key);
  }
  return { changed, stages };
}
