import { assert, describe, it } from "@effect/vitest";
import type {
  FeatureFlowTrunkConfig,
  FeatureFlowTrunkStage,
  ProjectId,
  ThreadId,
} from "@starcode/contracts";

import {
  inferDependencies,
  resolveConfiguredTrunks,
  resolveMergeability,
  resolveStage,
} from "./stage.logic.ts";

const project = "project-a" as ProjectId;
const thread = (id: string) => id as ThreadId;
const contained = (...stages: ReadonlyArray<FeatureFlowTrunkStage>) => new Set(stages);

describe("resolveStage", () => {
  it("reports in-progress when no trunk contains the work", () => {
    assert.strictEqual(resolveStage(contained()), "in-progress");
  });

  it("reports the furthest trunk the work has reached", () => {
    assert.strictEqual(resolveStage(contained("dev")), "in-dev");
    assert.strictEqual(resolveStage(contained("dev", "staging")), "in-staging");
    assert.strictEqual(resolveStage(contained("dev", "staging", "production")), "in-production");
  });

  it("does not require the lower trunks to also contain it", () => {
    // A hotfix cherry-picked straight to production is in production, even
    // though dev never saw it.
    assert.strictEqual(resolveStage(contained("production")), "in-production");
  });
});

describe("resolveConfiguredTrunks", () => {
  const configs: ReadonlyArray<FeatureFlowTrunkConfig> = [
    { stage: "dev", branch: "develop" },
    { stage: "production", branch: "release" },
  ] as ReadonlyArray<FeatureFlowTrunkConfig>;

  it("applies entries with no project to every project", () => {
    const resolved = resolveConfiguredTrunks(configs, project);
    assert.strictEqual(resolved.get("dev"), "develop");
    assert.strictEqual(resolved.get("production"), "release");
    assert.isUndefined(resolved.get("staging"));
  });

  it("lets a project-specific entry win over a fleet-wide one", () => {
    const resolved = resolveConfiguredTrunks(
      [
        ...configs,
        { stage: "dev", branch: "trunk", projectId: project },
      ] as ReadonlyArray<FeatureFlowTrunkConfig>,
      project,
    );
    assert.strictEqual(resolved.get("dev"), "trunk");
  });

  it("wins regardless of the order entries appear in", () => {
    const resolved = resolveConfiguredTrunks(
      [
        { stage: "dev", branch: "trunk", projectId: project },
        { stage: "dev", branch: "develop" },
      ] as ReadonlyArray<FeatureFlowTrunkConfig>,
      project,
    );
    assert.strictEqual(resolved.get("dev"), "trunk");
  });

  it("ignores entries aimed at a different project", () => {
    const resolved = resolveConfiguredTrunks(
      [
        { stage: "dev", branch: "other", projectId: "project-b" as ProjectId },
      ] as ReadonlyArray<FeatureFlowTrunkConfig>,
      project,
    );
    assert.strictEqual(resolved.size, 0);
  });
});

describe("resolveMergeability", () => {
  const base = { pullRequest: null, alreadyLanded: false } as const;

  it("calls landed work ready", () => {
    const result = resolveMergeability({ ...base, ahead: 0, behind: 0, alreadyLanded: true });
    assert.strictEqual(result.state, "ready");
  });

  it("calls work that is ahead and not behind ready", () => {
    assert.strictEqual(resolveMergeability({ ...base, ahead: 3, behind: 0 }).state, "ready");
  });

  it("calls work that is behind its trunk blocked", () => {
    assert.strictEqual(resolveMergeability({ ...base, ahead: 3, behind: 2 }).state, "blocked");
  });

  it("calls a closed pull request blocked", () => {
    const result = resolveMergeability({
      ...base,
      ahead: 3,
      behind: 0,
      pullRequest: { number: 12, state: "CLOSED", url: null },
    });
    assert.strictEqual(result.state, "blocked");
  });

  it("admits it does not know rather than guessing", () => {
    // Nothing measured at all.
    assert.strictEqual(
      resolveMergeability({ ...base, ahead: null, behind: null }).state,
      "unknown",
    );
    // Nothing to merge yet.
    assert.strictEqual(resolveMergeability({ ...base, ahead: 0, behind: 0 }).state, "unknown");
    // Ahead, but we could not tell whether it is also behind.
    assert.strictEqual(resolveMergeability({ ...base, ahead: 2, behind: null }).state, "unknown");
  });

  it("passes the raw counts through whatever it concludes", () => {
    const result = resolveMergeability({ ...base, ahead: 4, behind: 1 });
    assert.strictEqual(result.ahead, 4);
    assert.strictEqual(result.behind, 1);
  });
});

describe("inferDependencies", () => {
  const feature = {
    threadId: thread("t-stacked"),
    branch: "feat/b",
    stage: "in-progress",
  } as const;
  const ancestorOf = (pairs: ReadonlyArray<readonly [string, string]>) => {
    const set = new Set(pairs.map(([left, right]) => `${left} ${right}`));
    return (ancestor: string, descendant: string) => set.has(`${ancestor} ${descendant}`);
  };

  it("links a branch to the unlanded branch it was stacked on", () => {
    const edges = inferDependencies(
      feature,
      [{ threadId: thread("t-base"), branch: "feat/a", stage: "in-progress" }, feature],
      ancestorOf([["feat/a", "feat/b"]]),
    );
    assert.deepStrictEqual(edges, [{ dependsOnThreadId: thread("t-base"), source: "inferred" }]);
  });

  it("ignores work that already landed", () => {
    // Once a branch is in dev, everything cut from dev contains it — true, and
    // useless as a dependency.
    const edges = inferDependencies(
      feature,
      [{ threadId: thread("t-base"), branch: "feat/a", stage: "in-dev" }, feature],
      ancestorOf([["feat/a", "feat/b"]]),
    );
    assert.deepStrictEqual(edges, []);
  });

  it("does not link unrelated branches", () => {
    const edges = inferDependencies(
      feature,
      [{ threadId: thread("t-other"), branch: "feat/c", stage: "in-progress" }, feature],
      ancestorOf([]),
    );
    assert.deepStrictEqual(edges, []);
  });

  it("never links a feature to itself, or to a thread sharing its branch", () => {
    const edges = inferDependencies(
      feature,
      [feature, { threadId: thread("t-twin"), branch: "feat/b", stage: "in-progress" }],
      ancestorOf([["feat/b", "feat/b"]]),
    );
    assert.deepStrictEqual(edges, []);
  });

  it("reports nothing for a thread with no branch", () => {
    const edges = inferDependencies(
      { threadId: thread("t-none"), branch: null, stage: "in-progress" },
      [{ threadId: thread("t-base"), branch: "feat/a", stage: "in-progress" }],
      ancestorOf([]),
    );
    assert.deepStrictEqual(edges, []);
  });
});

describe("mergeability of unattributable work", () => {
  it("reports unknown rather than ready when no counts could be attributed", () => {
    // A thread with no branch of its own has no ahead/behind to report. It must
    // not inherit the enclosing checkout's numbers and claim to be mergeable.
    const result = resolveMergeability({
      ahead: null,
      behind: null,
      pullRequest: null,
      alreadyLanded: false,
    });
    assert.strictEqual(result.state, "unknown");
    assert.isNull(result.ahead);
    assert.isNull(result.behind);
  });
});
