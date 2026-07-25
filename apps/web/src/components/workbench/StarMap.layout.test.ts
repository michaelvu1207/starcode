import { describe, expect, it } from "vite-plus/test";

import { buildSkyForest, layoutSky, skySeed, SKY_LAYOUT, SKY_TIER_LABELS } from "./StarMap.layout";
import type { SkyFeature, SkyModel } from "./StarMap.model";

const SIZE = { width: 900, height: 640 };

function feature(key: string, overrides?: Partial<SkyFeature>): SkyFeature {
  return {
    key,
    name: key,
    description: null,
    stage: "in-progress",
    stageReported: true,
    threadRef: { environmentId: "env-mac", threadId: key },
    machineLabel: "mac",
    projectTitle: null,
    tone: "working",
    alive: false,
    settled: false,
    planned: false,
    planSummary: null,
    mergeability: "unknown",
    dependsOnKeys: [],
    masterAuthored: false,
    lastActivityAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

function model(features: ReadonlyArray<SkyFeature>, master?: SkyModel["master"]): SkyModel {
  return {
    features,
    master: master ?? null,
    realCount: features.filter((entry) => !entry.planned).length,
    plannedCount: features.filter((entry) => entry.planned).length,
    stageUnsupportedLabels: [],
    diagnostics: [],
  };
}

describe("skySeed", () => {
  it("is stable for a key and different between keys", () => {
    expect(skySeed("env-mac:t-1")).toBe(skySeed("env-mac:t-1"));
    expect(skySeed("env-mac:t-1")).not.toBe(skySeed("env-mac:t-2"));
  });
});

describe("buildSkyForest", () => {
  it("roots a feature that waits on nothing at the origin", () => {
    const forest = buildSkyForest([feature("a"), feature("b")]);
    expect([...forest.roots]).toEqual(["a", "b"]);
    expect(forest.parentOf.size).toBe(0);
  });

  it("hangs a feature off the one it waits on", () => {
    const forest = buildSkyForest([feature("a"), feature("b", { dependsOnKeys: ["a"] })]);
    expect([...forest.roots]).toEqual(["a"]);
    expect(forest.parentOf.get("b")).toBe("a");
    expect([...(forest.childrenOf.get("a") ?? [])]).toEqual(["b"]);
    expect(forest.depthOf.get("b")).toBe(1);
  });

  it("draws one lineage when a feature waits on several things", () => {
    const forest = buildSkyForest([
      feature("a"),
      feature("b"),
      feature("c", { dependsOnKeys: ["a", "b"] }),
    ]);
    // The tree can only show one parent; the rest stay on the card.
    expect(forest.parentOf.get("c")).toBe("a");
  });

  it("re-roots a feature whose ancestry loops, rather than failing to lay out", () => {
    const forest = buildSkyForest([
      feature("a", { dependsOnKeys: ["b"] }),
      feature("b", { dependsOnKeys: ["a"] }),
    ]);
    expect(forest.roots.length).toBeGreaterThan(0);
    expect(forest.depthOf.get("a")).toBe(0);
  });

  it("orders siblings by key, so the tree is the same picture every render", () => {
    const forest = buildSkyForest([
      feature("root"),
      feature("zulu", { dependsOnKeys: ["root"] }),
      feature("alpha", { dependsOnKeys: ["root"] }),
    ]);
    expect([...(forest.childrenOf.get("root") ?? [])]).toEqual(["alpha", "zulu"]);
  });
});

describe("layoutSky", () => {
  it("places the same sky identically every time it is laid out", () => {
    const sky = model([feature("a"), feature("b", { stage: "in-dev" })]);
    const first = layoutSky(sky, SIZE);
    const second = layoutSky(sky, SIZE);
    const rebuilt = layoutSky(model([feature("a"), feature("b", { stage: "in-dev" })]), SIZE);

    const positions = (layout: typeof first) =>
      layout.features.map((placed) => [placed.feature.key, placed.x, placed.y]);
    expect(positions(second)).toEqual(positions(first));
    // Rebuilding the model must not move anything either: position comes from
    // the key and the tree, never from identity or construction order.
    expect(positions(rebuilt)).toEqual(positions(first));
  });

  it("raises a feature through the sky as its tier advances", () => {
    const layout = layoutSky(
      model([
        feature("a"),
        feature("b", { stage: "in-dev" }),
        feature("c", { stage: "in-staging" }),
        feature("d", { stage: "in-production" }),
      ]),
      SIZE,
    );
    const y = (key: string) => layout.features.find((placed) => placed.feature.key === key)!.y;

    expect(y("a")).toBeGreaterThan(y("b"));
    expect(y("b")).toBeGreaterThan(y("c"));
    expect(y("c")).toBeGreaterThan(y("d"));
    // And everything sits above the shared start it grew from.
    expect(y("a")).toBeLessThan(layout.origin.y);
  });

  it("names the tiers in the operator's words, not the repository's", () => {
    const layout = layoutSky(model([feature("a")]), SIZE);
    expect(layout.tiers.map((tier) => tier.label)).toEqual([
      SKY_TIER_LABELS["in-progress"],
      SKY_TIER_LABELS["in-dev"],
      SKY_TIER_LABELS["in-staging"],
      SKY_TIER_LABELS["in-production"],
    ]);
    expect(layout.tiers.map((tier) => tier.label)).toEqual([
      "in flight",
      "landed",
      "ready",
      "shipped",
    ]);
    expect(layout.origin.label).toBe("latest");
  });

  it("puts the origin on the horizon, centred under the field", () => {
    const layout = layoutSky(model([feature("a")]), SIZE);
    expect(layout.origin.y).toBeLessThan(layout.horizonY);
    expect(layout.origin.x).toBeGreaterThan(SKY_LAYOUT.gutterWidth);
    expect(layout.origin.x).toBeLessThan(SIZE.width);
  });

  it("grows every branch from the origin or from the feature it waits on", () => {
    const layout = layoutSky(
      model([feature("a"), feature("b", { dependsOnKeys: ["a"], stage: "in-dev" }), feature("c")]),
      SIZE,
    );

    const branches = new Map(layout.branches.map((branch) => [branch.toKey, branch.fromKey]));
    expect(branches.get("a")).toBeNull();
    expect(branches.get("c")).toBeNull();
    expect(branches.get("b")).toBe("a");
    // Every feature is connected: nothing floats unattached in the sky.
    expect(layout.branches).toHaveLength(3);
  });

  it("traces outward from the root, so the sky draws itself in growing order", () => {
    const layout = layoutSky(
      model([feature("a"), feature("b", { dependsOnKeys: ["a"], stage: "in-dev" })]),
      SIZE,
    );
    const order = new Map(layout.branches.map((branch) => [branch.toKey, branch.order]));
    expect(order.get("a")!).toBeLessThan(order.get("b")!);
  });

  it("marks a branch planned when either end is intent", () => {
    const layout = layoutSky(
      model([feature("a"), feature("p", { dependsOnKeys: ["a"], planned: true })]),
      SIZE,
    );
    const planned = layout.branches.filter((branch) => branch.planned);
    expect(planned.map((branch) => branch.toKey)).toEqual(["p"]);
  });

  it("gives siblings room in proportion to the subtree each carries", () => {
    const layout = layoutSky(
      model([
        feature("wide"),
        feature("wide-1", { dependsOnKeys: ["wide"], stage: "in-dev" }),
        feature("wide-2", { dependsOnKeys: ["wide"], stage: "in-dev" }),
        feature("wide-3", { dependsOnKeys: ["wide"], stage: "in-dev" }),
        feature("narrow"),
      ]),
      SIZE,
    );
    const x = (key: string) => layout.features.find((placed) => placed.feature.key === key)!.x;
    const children = ["wide-1", "wide-2", "wide-3"].map(x);
    // Children spread under their parent rather than stacking on it.
    expect(new Set(children).size).toBe(3);
    // Roots are laid out in key order, so the single-leaf tree comes first and
    // the three-leaf one occupies the rest of the field without overlapping it.
    expect(x("narrow")).toBeLessThan(Math.min(...children));
    expect(x("wide")).toBeGreaterThan(x("narrow"));
  });

  it("keeps every feature inside the field and clear of the axis", () => {
    const features = Array.from({ length: 26 }, (_, index) => feature(`t-${index}`));
    const layout = layoutSky(model(features), SIZE);

    for (const placed of layout.features) {
      expect(placed.x).toBeGreaterThan(SKY_LAYOUT.gutterWidth - SKY_LAYOUT.starRadius);
      expect(placed.x).toBeLessThan(SIZE.width);
      expect(placed.y).toBeLessThan(layout.origin.y);
      expect(placed.y).toBeGreaterThan(SKY_LAYOUT.zenithHeight - SKY_LAYOUT.maxTierHeight);
    }
  });

  it("hangs the moon only when an orchestrator is designated", () => {
    expect(layoutSky(model([feature("a")]), SIZE).moon).toBeNull();

    const withMaster = layoutSky(
      model([feature("a")], {
        key: "env-mac:t-master",
        threadId: "t-master",
        environmentId: "env-mac",
        machineLabel: "mac",
        title: "Orchestrator",
        alive: false,
      }),
      SIZE,
    );
    expect(withMaster.moon!.y).toBeLessThan(withMaster.tiers[3]!.top);
  });

  it("gives every star a twinkle already under way and never in unison", () => {
    const features = Array.from({ length: 12 }, (_, index) => feature(`t-${index}`));
    const layout = layoutSky(model(features), SIZE);

    for (const placed of layout.features) {
      expect(placed.twinklePeriodSeconds).toBeGreaterThanOrEqual(19);
      expect(placed.twinkleDelaySeconds).toBeLessThanOrEqual(0);
      expect(Math.abs(placed.twinkleDelaySeconds)).toBeLessThanOrEqual(placed.twinklePeriodSeconds);
    }
    expect(
      new Set(layout.features.map((placed) => placed.twinkleDelaySeconds)).size,
    ).toBeGreaterThan(1);
  });

  it("lays out an empty sky with tiers and an origin and nothing else", () => {
    const layout = layoutSky(model([]), SIZE);
    expect(layout.features).toEqual([]);
    expect(layout.branches).toEqual([]);
    expect(layout.tiers).toHaveLength(4);
    expect(layout.origin.radius).toBeGreaterThan(0);
  });

  it("pushes apart a parent and its child that share a tier", () => {
    // The plan produces this constantly: a step that waits on another step, both
    // still in flight. Centring each over its own span would stack them on one
    // point and make one of them unreachable.
    const layout = layoutSky(model([feature("a"), feature("b", { dependsOnKeys: ["a"] })]), SIZE);
    const x = (key: string) => layout.features.find((placed) => placed.feature.key === key)!.x;
    expect(Math.abs(x("a") - x("b"))).toBeGreaterThanOrEqual(SKY_LAYOUT.starRadius * 2);
  });

  it("never lets two features in one tier overlap, however crowded it gets", () => {
    const features = Array.from({ length: 18 }, (_, index) => feature(`t-${index}`));
    const layout = layoutSky(model(features), { width: 700, height: 640 });

    for (const left of layout.features) {
      for (const right of layout.features) {
        if (left.feature.key === right.feature.key) continue;
        expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeGreaterThan(left.radius * 2);
      }
    }
  });

  it("holds a floor under a pane too small to draw a sky in", () => {
    const layout = layoutSky(model([feature("a")]), { width: 40, height: 20 });
    expect(layout.width).toBeGreaterThanOrEqual(320);
    expect(layout.height).toBeGreaterThanOrEqual(340);
    expect(layout.features[0]!.x).toBeGreaterThan(SKY_LAYOUT.gutterWidth - SKY_LAYOUT.starRadius);
  });
});
