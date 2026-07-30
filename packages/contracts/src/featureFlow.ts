/**
 * Feature flow — where each thread's work has reached on its way to production.
 *
 * This is a *feature*-level model deliberately built on git plumbing that never
 * surfaces. A thread is a feature; its stage is computed by asking git whether
 * the thread's branch is contained in a trunk, and the answer is reported as a
 * stage name. Branch names, worktrees, commit structure, and ahead/behind
 * counts exist here only because the computation needs them — the consuming UI
 * shows a feature sitting in a lane, not a git graph.
 *
 * @module FeatureFlow
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationThreadPlanSummary } from "./orchestration.ts";
import { PeerThreadStatus } from "./peers.ts";

/**
 * The trunks a feature flows through. `dev` is the integration trunk every
 * feature targets first; `staging` and `production` are promotion trunks that
 * only ever receive work already in `dev`. A repository that has no staging or
 * production branch simply reports fewer trunks — the lanes are data, not a
 * fixed set.
 */
export const FeatureFlowTrunkStage = Schema.Literals(["dev", "staging", "production"]);
export type FeatureFlowTrunkStage = typeof FeatureFlowTrunkStage.Type;

/**
 * Where a feature currently sits. `in-progress` means "not yet contained in any
 * trunk", which is also the honest answer for a thread with no branch at all.
 */
export const FeatureFlowStage = Schema.Literals([
  "in-progress",
  "in-dev",
  "in-staging",
  "in-production",
]);
export type FeatureFlowStage = typeof FeatureFlowStage.Type;

export const FEATURE_FLOW_STAGE_BY_TRUNK: Readonly<
  Record<FeatureFlowTrunkStage, FeatureFlowStage>
> = {
  dev: "in-dev",
  staging: "in-staging",
  production: "in-production",
};

/**
 * Operator override for trunk detection. An entry without `projectId` applies
 * to every project, so the common case ("our trunks are dev/staging/main
 * everywhere") is three entries rather than one per repository.
 */
export const FeatureFlowTrunkConfig = Schema.Struct({
  stage: FeatureFlowTrunkStage,
  branch: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});
export type FeatureFlowTrunkConfig = typeof FeatureFlowTrunkConfig.Type;

export const FeatureFlowTrunk = Schema.Struct({
  stage: FeatureFlowTrunkStage,
  /** The git ref containment is tested against, e.g. `origin/dev` or `dev`. */
  ref: TrimmedNonEmptyString,
  source: Schema.Literals(["configured", "detected"]),
});
export type FeatureFlowTrunk = typeof FeatureFlowTrunk.Type;

/**
 * Coarse readiness, not a merge simulation. `blocked` means git or the forge
 * already knows something is in the way (behind its trunk, or a closed PR);
 * `unknown` means we could not tell, which a UI should render as absence rather
 * than as a problem. An actual `merge-tree` dry run is deliberately out of v1.
 */
export const FeatureFlowMergeabilityState = Schema.Literals(["ready", "blocked", "unknown"]);
export type FeatureFlowMergeabilityState = typeof FeatureFlowMergeabilityState.Type;

export const FeatureFlowPullRequest = Schema.Struct({
  number: NonNegativeInt,
  state: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type FeatureFlowPullRequest = typeof FeatureFlowPullRequest.Type;

export const FeatureFlowMergeability = Schema.Struct({
  state: FeatureFlowMergeabilityState,
  ahead: Schema.NullOr(NonNegativeInt),
  behind: Schema.NullOr(NonNegativeInt),
  pullRequest: Schema.NullOr(FeatureFlowPullRequest),
});
export type FeatureFlowMergeability = typeof FeatureFlowMergeability.Type;

/**
 * `inferred` edges come from stacked branches: A's tip is an ancestor of B's
 * tip and A is not yet in a trunk, so B literally contains A's work and cannot
 * land cleanly before it.
 *
 * `annotated` is reserved for an operator-declared dependency. starcode has no
 * free-form thread metadata field to carry one today, so nothing emits this
 * variant yet; it exists in the contract so adding the annotation later is a
 * server-only change and no client has to widen its parser under version skew.
 */
export const FeatureFlowDependencySource = Schema.Literals(["inferred", "annotated"]);
export type FeatureFlowDependencySource = typeof FeatureFlowDependencySource.Type;

export const FeatureFlowDependency = Schema.Struct({
  dependsOnThreadId: ThreadId,
  source: FeatureFlowDependencySource,
});
export type FeatureFlowDependency = typeof FeatureFlowDependency.Type;

export const FeatureFlowFeature = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  status: PeerThreadStatus,
  stage: FeatureFlowStage,
  /**
   * Kept for the client's benefit even though the UI never renders it: two
   * features on the same branch are the same work, and only the client knows
   * how it wants to collapse them.
   */
  branch: Schema.NullOr(TrimmedNonEmptyString),
  planSummary: Schema.NullOr(OrchestrationThreadPlanSummary),
  mergeability: FeatureFlowMergeability,
  dependsOn: Schema.Array(FeatureFlowDependency),
  lastActivityAt: IsoDateTime,
});
export type FeatureFlowFeature = typeof FeatureFlowFeature.Type;

export const FeatureFlowProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  trunks: Schema.Array(FeatureFlowTrunk),
  features: Schema.Array(FeatureFlowFeature),
  /**
   * Why a project's answer is incomplete — a workspace that is not a git
   * repository, an unreadable ref. Reported per project so one broken
   * repository degrades to "stages unknown" instead of failing the request.
   */
  diagnostics: Schema.Array(TrimmedNonEmptyString),
});
export type FeatureFlowProject = typeof FeatureFlowProject.Type;

export const FeatureFlowSnapshot = Schema.Struct({
  projects: Schema.Array(FeatureFlowProject),
  computedAt: IsoDateTime,
});
export type FeatureFlowSnapshot = typeof FeatureFlowSnapshot.Type;
