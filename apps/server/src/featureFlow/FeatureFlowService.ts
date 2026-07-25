/**
 * FeatureFlowService - which features have reached which stage, per project.
 *
 * All git access goes through `GitVcsDriver.execute` with `allowNonZeroExit`,
 * because every question asked here is a predicate: `merge-base --is-ancestor`
 * answers by exit code, and treating exit 1 as a failure would turn "not
 * contained" into an error. Nothing here mutates a repository.
 *
 * Cost is bounded by caching the whole snapshot briefly. The expensive part is
 * O(threads x trunks) ancestry checks plus O(threads^2) for dependency
 * inference, and at the scale this is designed for — a handful of active
 * features per project — that is a few dozen short git invocations. The cache
 * exists so a polling client cannot turn that into a treadmill.
 *
 * @module FeatureFlowService
 */
import {
  type FeatureFlowFeature,
  type FeatureFlowProject,
  type FeatureFlowSnapshot,
  type FeatureFlowTrunk,
  type FeatureFlowTrunkStage,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { peerThreadLastActivityAt, resolvePeerThreadStatus } from "../peers/transcript.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DEFAULT_TRUNK_CANDIDATES,
  inferDependencies,
  makeTrunk,
  resolveConfiguredTrunks,
  resolveMergeability,
  resolveStage,
  TRUNK_STAGE_PRECEDENCE,
} from "./stage.logic.ts";

/** Long enough that a polling panel is cheap, short enough to feel live. */
const SNAPSHOT_TTL = Duration.seconds(15);

export interface FeatureFlowServiceShape {
  readonly getSnapshot: Effect.Effect<FeatureFlowSnapshot>;
}

export class FeatureFlowService extends Context.Service<
  FeatureFlowService,
  FeatureFlowServiceShape
>()("t3/featureFlow/FeatureFlowService") {}

export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;

  /** Runs a git predicate. Any failure to run it at all reads as "no". */
  const gitPredicate = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git.execute({ operation, cwd, args: [...args], allowNonZeroExit: true }).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const refExists = (cwd: string, ref: string) =>
    gitPredicate(cwd, "FeatureFlow.refExists", [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);

  /**
   * Prefers the remote-tracking ref over the local branch. A local `dev` can be
   * stale or absent on a machine that only ever works in worktrees, whereas
   * `origin/dev` is what the rest of the fleet actually merged into — and
   * "has this shipped" is a question about the shared repository.
   */
  const resolveRef = Effect.fn("FeatureFlow.resolveRef")(function* (
    cwd: string,
    branch: string,
  ): Effect.fn.Return<string | null> {
    if (yield* refExists(cwd, `origin/${branch}`)) return `origin/${branch}`;
    if (yield* refExists(cwd, branch)) return branch;
    return null;
  });

  const resolveTrunks = Effect.fn("FeatureFlow.resolveTrunks")(function* (
    cwd: string,
    project: OrchestrationProjectShell,
  ): Effect.fn.Return<ReadonlyArray<FeatureFlowTrunk>> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const configured = resolveConfiguredTrunks(settings?.featureFlowTrunks ?? [], project.id);
    const trunks: Array<FeatureFlowTrunk> = [];

    for (const stage of TRUNK_STAGE_PRECEDENCE) {
      const explicit = configured.get(stage);
      if (explicit !== undefined) {
        const ref = yield* resolveRef(cwd, explicit);
        // A configured trunk that does not exist is still reported, so the
        // operator can see their configuration is wrong rather than silently
        // losing a lane.
        trunks.push(makeTrunk(stage, ref ?? explicit, "configured"));
        continue;
      }
      for (const candidate of DEFAULT_TRUNK_CANDIDATES[stage]) {
        const ref = yield* resolveRef(cwd, candidate);
        if (ref !== null) {
          trunks.push(makeTrunk(stage, ref, "detected"));
          break;
        }
      }
    }
    return trunks;
  });

  const buildProject = Effect.fn("FeatureFlow.buildProject")(function* (
    project: OrchestrationProjectShell,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): Effect.fn.Return<FeatureFlowProject> {
    const cwd = project.workspaceRoot;
    const diagnostics: Array<string> = [];

    const isRepo = yield* gitPredicate(cwd, "FeatureFlow.isRepo", [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (!isRepo) {
      return {
        projectId: project.id,
        title: project.title,
        workspaceRoot: cwd,
        trunks: [],
        features: threads.map(
          (thread) =>
            ({
              threadId: thread.id,
              title: thread.title,
              status: resolvePeerThreadStatus(thread),
              stage: "in-progress",
              branch: thread.branch,
              planSummary: thread.planSummary ?? null,
              mergeability: { state: "unknown", ahead: null, behind: null, pullRequest: null },
              dependsOn: [],
              lastActivityAt: peerThreadLastActivityAt(thread),
            }) as FeatureFlowFeature,
        ),
        diagnostics: ["Workspace is not a git repository; every feature reports as in progress."],
      } as FeatureFlowProject;
    }

    const trunks = yield* resolveTrunks(cwd, project);
    if (trunks.length === 0) {
      diagnostics.push("No dev, staging, or production branch was found in this repository.");
    }
    const devTrunk = trunks.find((trunk) => trunk.stage === "dev") ?? null;

    // Pass one: containment, which every later answer depends on.
    const staged = yield* Effect.forEach(threads, (thread) =>
      Effect.gen(function* () {
        if (thread.branch === null) {
          return {
            thread,
            stage: "in-progress" as const,
            contained: new Set<FeatureFlowTrunkStage>(),
          };
        }
        const branchRef = yield* resolveRef(cwd, thread.branch);
        if (branchRef === null) {
          return {
            thread,
            stage: "in-progress" as const,
            contained: new Set<FeatureFlowTrunkStage>(),
          };
        }
        const contained = new Set<FeatureFlowTrunkStage>();
        for (const trunk of trunks) {
          const isContained = yield* gitPredicate(cwd, "FeatureFlow.isAncestor", [
            "merge-base",
            "--is-ancestor",
            branchRef,
            trunk.ref,
          ]);
          if (isContained) contained.add(trunk.stage);
        }
        return { thread, stage: resolveStage(contained), contained };
      }),
    );

    const candidates = staged.map((entry) => ({
      threadId: entry.thread.id,
      branch: entry.thread.branch,
      stage: entry.stage,
    }));

    // Pass two: ancestry between feature branches, precomputed so the pure
    // inference can stay synchronous.
    const ancestry = new Map<string, boolean>();
    for (const left of candidates) {
      for (const right of candidates) {
        if (left.branch === null || right.branch === null) continue;
        if (left.branch === right.branch) continue;
        if (left.stage !== "in-progress") continue;
        const key = `${left.branch} ${right.branch}`;
        if (ancestry.has(key)) continue;
        ancestry.set(
          key,
          yield* gitPredicate(cwd, "FeatureFlow.stackedAncestor", [
            "merge-base",
            "--is-ancestor",
            left.branch,
            right.branch,
          ]),
        );
      }
    }
    const isAncestor = (ancestorBranch: string, descendantBranch: string): boolean =>
      ancestry.get(`${ancestorBranch} ${descendantBranch}`) ?? false;

    const features = yield* Effect.forEach(staged, (entry) =>
      Effect.gen(function* () {
        const { thread, stage } = entry;
        // Ahead/behind and PR state come from the status the server already
        // computes and caches for this checkout, so the panel costs no extra
        // network round trip to the forge.
        const statusCwd = thread.worktreePath ?? cwd;
        const rawStatus = yield* gitWorkflow
          .status({ cwd: statusCwd })
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        // Status is a property of a *checkout*, not of a thread. A thread with
        // no worktree of its own shares the project's, whose current branch is
        // whatever someone last checked out — so unless that branch is this
        // thread's, the counts describe different work and must be discarded.
        // Reporting them anyway is how a feature with no branch at all ends up
        // claiming it is ready to merge.
        const status =
          rawStatus !== null && thread.branch !== null && rawStatus.refName === thread.branch
            ? rawStatus
            : null;
        const pr = status?.pr ?? null;
        const behind = status?.behindCount ?? null;
        // `aheadOfDefaultCount` is the count against the repository's default
        // branch, which is the trunk this panel cares about; `aheadCount` is
        // against the branch's own upstream and only stands in when the
        // former was not computed.
        const ahead = status?.aheadOfDefaultCount ?? status?.aheadCount ?? null;

        return {
          threadId: thread.id,
          title: thread.title,
          status: resolvePeerThreadStatus(thread),
          stage,
          branch: thread.branch,
          planSummary: thread.planSummary ?? null,
          mergeability: resolveMergeability({
            ahead,
            behind,
            pullRequest:
              pr === null ? null : { number: pr.number, state: pr.state, url: pr.url ?? null },
            alreadyLanded: stage !== "in-progress",
          }),
          dependsOn: inferDependencies(
            { threadId: thread.id, branch: thread.branch, stage },
            candidates,
            isAncestor,
          ),
          lastActivityAt: peerThreadLastActivityAt(thread),
        } as FeatureFlowFeature;
      }),
    );

    if (devTrunk === null) {
      diagnostics.push("No dev branch was found, so nothing can be reported as merged.");
    }

    return {
      projectId: project.id,
      title: project.title,
      workspaceRoot: cwd,
      trunks,
      features,
      diagnostics,
    } as FeatureFlowProject;
  });

  const computeSnapshot = Effect.fn("FeatureFlow.computeSnapshot")(function* () {
    const shell = yield* projectionSnapshotQuery.getShellSnapshot();
    const active = shell.threads.filter((thread) => thread.archivedAt === null);
    const projects = yield* Effect.forEach(shell.projects, (project) =>
      buildProject(
        project,
        active.filter((thread) => thread.projectId === project.id),
      ),
    );
    const computedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    return { projects, computedAt } as FeatureFlowSnapshot;
  });

  const cache = yield* Cache.makeWith(
    (_key: string) =>
      computeSnapshot().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("feature flow snapshot failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.andThen(
              DateTime.now.pipe(
                Effect.map(
                  (now) =>
                    ({
                      projects: [],
                      computedAt: DateTime.formatIso(now),
                    }) as FeatureFlowSnapshot,
                ),
              ),
            ),
          ),
        ),
      ),
    { capacity: 1, timeToLive: () => SNAPSHOT_TTL },
  );

  return {
    getSnapshot: Cache.get(cache, "snapshot"),
  } satisfies FeatureFlowServiceShape;
});

export const layer: Layer.Layer<
  FeatureFlowService,
  never,
  GitVcsDriver.GitVcsDriver | GitWorkflowService | ProjectionSnapshotQuery | ServerSettingsService
> = Layer.effect(FeatureFlowService, make);
