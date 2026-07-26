import type { FeatureMapEntry, FeatureMapEntryId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextStage, pruneDanglingLinks, resolvePlan, wouldCycle } from "./featureMap.logic.ts";

const id = (value: string) => value as FeatureMapEntryId;

const entry = (value: string, dependsOn: ReadonlyArray<string> = []): FeatureMapEntry =>
  ({
    id: id(value),
    name: value,
    description: null,
    threadId: null,
    slug: null,
    stage: "in-progress",
    dependsOn: dependsOn.map(id),
    planned: false,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }) as FeatureMapEntry;

describe("nextStage", () => {
  it("advances one step up the chain", () => {
    expect(nextStage("in-progress")).toBe("in-dev");
    expect(nextStage("in-dev")).toBe("in-staging");
    expect(nextStage("in-staging")).toBe("in-production");
  });

  it("refuses to promote something that has already shipped", () => {
    expect(nextStage("in-production")).toBeNull();
  });
});

describe("wouldCycle", () => {
  it("refuses a feature that waits on itself", () => {
    expect(wouldCycle([entry("a")], id("a"), id("a"))).toBe(true);
  });

  it("refuses a link that closes a loop through other features", () => {
    const entries = [entry("a"), entry("b", ["a"]), entry("c", ["b"])];
    // c already reaches a, so a waiting on c would close the ring.
    expect(wouldCycle(entries, id("a"), id("c"))).toBe(true);
  });

  it("allows a link that only deepens the tree", () => {
    const entries = [entry("a"), entry("b", ["a"]), entry("c")];
    expect(wouldCycle(entries, id("c"), id("b"))).toBe(false);
  });

  it("terminates on a map that already contains a loop", () => {
    // A pre-existing ring the new edge is not part of must not hang the walk,
    // and must not be reported as a cycle the caller just caused.
    const entries = [entry("a", ["b"]), entry("b", ["a"])];
    expect(wouldCycle(entries, id("c"), id("a"))).toBe(false);
  });
});

describe("pruneDanglingLinks", () => {
  it("drops links to features that are no longer on the map", () => {
    const pruned = pruneDanglingLinks([entry("a", ["gone", "b"]), entry("b")]);
    expect(pruned[0]!.dependsOn).toEqual([id("b")]);
  });

  it("leaves an intact map untouched", () => {
    const entries = [entry("a", ["b"]), entry("b")];
    expect(pruneDanglingLinks(entries)[0]).toBe(entries[0]);
  });
});

describe("resolvePlan", () => {
  it("wires dependencies by the caller's own keys", () => {
    const plan = resolvePlan([
      { key: "one", name: "First" },
      { key: "two", name: "Second", dependsOn: ["one"] },
    ]);
    expect(plan.entries[1]!.dependsOnKeys).toEqual(["one"]);
  });

  it("defaults an unstated stage to the start of the chain", () => {
    expect(resolvePlan([{ key: "one", name: "First" }]).entries[0]!.stage).toBe("in-progress");
  });

  it("drops references outside the plan rather than refusing the whole write", () => {
    const plan = resolvePlan([{ key: "one", name: "First", dependsOn: ["absent", "one"] }]);
    expect(plan.entries[0]!.dependsOnKeys).toEqual([]);
    expect(plan.entries).toHaveLength(1);
  });
});
