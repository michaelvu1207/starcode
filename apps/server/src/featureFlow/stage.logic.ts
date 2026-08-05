/**
 * The pure half of feature flow: given answers from git, decide what to report.
 *
 * Kept free of Effect and of the git driver so the interesting decisions —
 * which trunk wins when a branch is in several, what counts as a dependency,
 * when readiness is unknowable — are testable without a repository.
 *
 * @module FeatureFlowStageLogic
 */
import {
  FEATURE_FLOW_STAGE_BY_TRUNK,
  type FeatureFlowDependency,
  type FeatureFlowMergeability,
  type FeatureFlowStage,
  type FeatureFlowTrunk,
  type FeatureFlowTrunkConfig,
  type FeatureFlowTrunkStage,
  type ProjectId,
  type ThreadId,
} from "@starcode/contracts";

/**
 * Most-promoted first. Containment is transitive in practice — work in
 * production is normally also in staging and dev — so "which stage is this in"
 * means "the furthest one it has reached", and this order is what makes that
 * the first match rather than a comparison.
 */
export const TRUNK_STAGE_PRECEDENCE: ReadonlyArray<FeatureFlowTrunkStage> = [
  "production",
  "staging",
  "dev",
];

/**
 * Branch names probed when nothing is configured, per stage, in preference
 * order. `main`/`master` sit under `dev` rather than getting a lane of their
 * own: in a repository with no dev branch, main *is* where work integrates,
 * and inventing a fourth lane for it would show every feature as never having
 * shipped.
 */
export const DEFAULT_TRUNK_CANDIDATES: Readonly<
  Record<FeatureFlowTrunkStage, ReadonlyArray<string>>
> = {
  dev: ["dev", "develop", "development", "main", "master"],
  staging: ["staging", "stage", "preprod"],
  production: ["production", "prod", "release"],
};

/**
 * Configured trunks win over detection, and a project-specific entry wins over
 * a fleet-wide one. Returns the branch to probe per stage, or nothing for a
 * stage the operator did not configure — that stage then falls back to
 * detection.
 */
export const resolveConfiguredTrunks = (
  configs: ReadonlyArray<FeatureFlowTrunkConfig>,
  projectId: ProjectId,
): ReadonlyMap<FeatureFlowTrunkStage, string> => {
  const resolved = new Map<FeatureFlowTrunkStage, string>();
  for (const config of configs) {
    if (config.projectId !== undefined && config.projectId !== projectId) continue;
    const specific = config.projectId !== undefined;
    // A global entry must not overwrite a project-specific one already seen.
    if (!specific && resolved.has(config.stage)) continue;
    resolved.set(config.stage, config.branch);
  }
  // Second pass so project-specific entries win regardless of file order.
  for (const config of configs) {
    if (config.projectId === projectId) resolved.set(config.stage, config.branch);
  }
  return resolved;
};

/**
 * The furthest trunk containing this branch, as a stage. A branch contained in
 * nothing — including a thread that has no branch at all — is in progress,
 * which is the honest answer rather than a missing one.
 */
export const resolveStage = (containedIn: ReadonlySet<FeatureFlowTrunkStage>): FeatureFlowStage => {
  for (const stage of TRUNK_STAGE_PRECEDENCE) {
    if (containedIn.has(stage)) return FEATURE_FLOW_STAGE_BY_TRUNK[stage];
  }
  return "in-progress";
};

export interface MergeabilityInput {
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly pullRequest: FeatureFlowMergeability["pullRequest"];
  readonly alreadyLanded: boolean;
}

/**
 * Deliberately conservative. `ready` is claimed only when git says the branch
 * has something to merge and is not behind its trunk; anything we could not
 * measure reports `unknown`, because a confident wrong "ready" costs the
 * operator a failed merge and a confident wrong "blocked" costs them a merge
 * they never attempted.
 */
export const resolveMergeability = (input: MergeabilityInput): FeatureFlowMergeability => {
  const base = {
    ahead: input.ahead,
    behind: input.behind,
    pullRequest: input.pullRequest,
  } as const;

  // Work that already reached a trunk has nothing left to merge.
  if (input.alreadyLanded) return { ...base, state: "ready" };
  if (input.pullRequest !== null && input.pullRequest.state.toLowerCase() === "closed") {
    return { ...base, state: "blocked" };
  }
  if (input.ahead === null) return { ...base, state: "unknown" };
  if (input.ahead === 0) return { ...base, state: "unknown" };
  if (input.behind !== null && input.behind > 0) return { ...base, state: "blocked" };
  if (input.behind === null) return { ...base, state: "unknown" };
  return { ...base, state: "ready" };
};

export interface DependencyCandidate {
  readonly threadId: ThreadId;
  readonly branch: string | null;
  readonly stage: FeatureFlowStage;
}

/**
 * Stacked-branch inference. B depends on A when A's tip is an ancestor of B's
 * tip and A has not landed yet: B literally contains A's commits, so merging B
 * first would drag A in with it.
 *
 * The `alreadyLanded` exclusion is what stops every feature from depending on
 * every other one — once A is in dev, every branch cut from dev contains A, and
 * reporting that would be true and useless.
 *
 * `isAncestor` is asked for ordered pairs only; it is the caller's job to have
 * answered it for `(candidate, feature)` in that direction.
 */
export const inferDependencies = (
  feature: DependencyCandidate,
  candidates: ReadonlyArray<DependencyCandidate>,
  isAncestor: (ancestorBranch: string, descendantBranch: string) => boolean,
): ReadonlyArray<FeatureFlowDependency> => {
  if (feature.branch === null) return [];
  const edges: Array<FeatureFlowDependency> = [];
  for (const candidate of candidates) {
    if (candidate.threadId === feature.threadId) continue;
    if (candidate.branch === null) continue;
    if (candidate.branch === feature.branch) continue;
    if (candidate.stage !== "in-progress") continue;
    if (!isAncestor(candidate.branch, feature.branch)) continue;
    edges.push({ dependsOnThreadId: candidate.threadId, source: "inferred" });
  }
  return edges;
};

/** Shapes a resolved trunk for the response. */
export const makeTrunk = (
  stage: FeatureFlowTrunkStage,
  ref: string,
  source: FeatureFlowTrunk["source"],
): FeatureFlowTrunk => ({ stage, ref, source }) as FeatureFlowTrunk;
