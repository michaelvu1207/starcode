import { describe, expect, it } from "vite-plus/test";

import { layoutStarMap, starSeed, STAR_MAP_LAYOUT } from "./StarMap.layout";
import type { StarMapModel, StarMapRegion, StarMapStar } from "./StarMap.model";

const SIZE = { width: 900, height: 620 };

function star(key: string, overrides?: Partial<StarMapStar>): StarMapStar {
  const [environmentId, threadId] = key.split(":") as [string, string];
  return {
    key,
    threadId,
    environmentId,
    machineLabel: environmentId,
    title: threadId,
    projectTitle: null,
    stage: "in-progress",
    stageReported: true,
    tone: "working",
    alive: false,
    settled: false,
    planSummary: null,
    mergeability: "unknown",
    masterCreated: false,
    dependsOnKeys: [],
    lastActivityAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

function region(environmentId: string, stars: ReadonlyArray<StarMapStar>): StarMapRegion {
  return { environmentId, label: environmentId, isLocal: environmentId === "mac", stars };
}

function model(
  regions: ReadonlyArray<StarMapRegion>,
  master?: StarMapModel["master"],
): StarMapModel {
  return {
    regions,
    master: master ?? null,
    starCount: regions.reduce((total, entry) => total + entry.stars.length, 0),
    stageUnsupportedLabels: [],
    diagnostics: [],
  };
}

describe("starSeed", () => {
  it("is stable for a key and different between keys", () => {
    expect(starSeed("env-mac:t-1")).toBe(starSeed("env-mac:t-1"));
    expect(starSeed("env-mac:t-1")).not.toBe(starSeed("env-mac:t-2"));
  });
});

describe("layoutStarMap", () => {
  it("places the same sky identically every time it is laid out", () => {
    const sky = model([region("mac", [star("mac:t-1"), star("mac:t-2", { stage: "in-dev" })])]);
    const first = layoutStarMap(sky, SIZE);
    const second = layoutStarMap(sky, SIZE);

    expect(second.stars.map((placed) => [placed.star.key, placed.x, placed.y])).toEqual(
      first.stars.map((placed) => [placed.star.key, placed.x, placed.y]),
    );
    // Rebuilding the model object must not move anything either: position comes
    // from the key, never from identity or order of construction.
    const rebuilt = layoutStarMap(
      model([region("mac", [star("mac:t-1"), star("mac:t-2", { stage: "in-dev" })])]),
      SIZE,
    );
    expect(rebuilt.stars.map((placed) => placed.x)).toEqual(first.stars.map((placed) => placed.x));
  });

  it("does not move a star when unrelated work changes around it", () => {
    const before = layoutStarMap(
      model([region("mac", [star("mac:t-1")]), region("laptop", [star("laptop:t-9")])]),
      SIZE,
    );
    const after = layoutStarMap(
      model([
        region("mac", [star("mac:t-1")]),
        region("laptop", [star("laptop:t-9"), star("laptop:t-10")]),
      ]),
      SIZE,
    );

    const find = (layout: typeof before, key: string) =>
      layout.stars.find((placed) => placed.star.key === key)!;
    expect([find(after, "mac:t-1").x, find(after, "mac:t-1").y]).toEqual([
      find(before, "mac:t-1").x,
      find(before, "mac:t-1").y,
    ]);
  });

  it("raises work through the sky as its stage advances", () => {
    const layout = layoutStarMap(
      model([
        region("mac", [
          star("mac:a"),
          star("mac:b", { stage: "in-dev" }),
          star("mac:c", { stage: "in-staging" }),
          star("mac:d", { stage: "in-production" }),
        ]),
      ]),
      SIZE,
    );
    const y = (key: string) => layout.stars.find((placed) => placed.star.key === key)!.y;

    expect(y("mac:a")).toBeGreaterThan(y("mac:b"));
    expect(y("mac:b")).toBeGreaterThan(y("mac:c"));
    expect(y("mac:c")).toBeGreaterThan(y("mac:d"));
  });

  it("orders the bands with production at the zenith and in progress on the horizon", () => {
    const layout = layoutStarMap(model([region("mac", [star("mac:a")])]), SIZE);
    expect(layout.bands.map((band) => band.stage)).toEqual([
      "in-progress",
      "in-dev",
      "in-staging",
      "in-production",
    ]);
    const byStage = new Map(layout.bands.map((band) => [band.stage, band]));
    expect(byStage.get("in-production")!.top).toBeLessThan(byStage.get("in-progress")!.top);
    expect(
      byStage.get("in-progress")!.top + byStage.get("in-progress")!.height,
    ).toBeLessThanOrEqual(layout.horizonY + 0.5);
  });

  it("keeps every star inside its own machine's region", () => {
    const layout = layoutStarMap(
      model([
        region("mac", [star("mac:a"), star("mac:b")]),
        region("laptop", [star("laptop:a"), star("laptop:b")]),
        region("path-pc", [star("path-pc:a")]),
      ]),
      SIZE,
    );

    for (const placed of layout.stars) {
      const own = layout.regions.find(
        (entry) => entry.environmentId === placed.star.environmentId,
      )!;
      expect(placed.x).toBeGreaterThanOrEqual(own.x);
      expect(placed.x).toBeLessThanOrEqual(own.x + own.width);
    }
  });

  it("keeps stars clear of the axis gutter and the horizon", () => {
    const layout = layoutStarMap(
      model([
        region(
          "mac",
          Array.from({ length: 24 }, (_, index) => star(`mac:t-${index}`)),
        ),
      ]),
      SIZE,
    );

    for (const placed of layout.stars) {
      expect(placed.x).toBeGreaterThan(STAR_MAP_LAYOUT.gutterWidth);
      expect(placed.y).toBeLessThan(layout.horizonY);
      expect(placed.y).toBeGreaterThan(STAR_MAP_LAYOUT.zenithHeight);
    }
  });

  it("wraps a crowded stage into rows instead of letting its stars collide", () => {
    const layout = layoutStarMap(
      model([
        region(
          "mac",
          Array.from({ length: 30 }, (_, index) => star(`mac:t-${index}`)),
        ),
      ]),
      { width: 700, height: 620 },
    );
    const rows = new Set(layout.stars.map((placed) => Math.round(placed.y / 6)));
    expect(rows.size).toBeGreaterThan(1);

    // No two stars closer than a star's own diameter.
    for (const left of layout.stars) {
      for (const right of layout.stars) {
        if (left.star.key === right.star.key) continue;
        expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeGreaterThan(left.radius * 2);
      }
    }
  });

  it("joins a machine's stars into one constellation figure and no more", () => {
    const layout = layoutStarMap(
      model([
        region("mac", [star("mac:a"), star("mac:b", { stage: "in-dev" }), star("mac:c")]),
        region("laptop", [star("laptop:a")]),
      ]),
      SIZE,
    );

    const figures = layout.edges.filter((edge) => edge.kind === "figure");
    // A chain through n stars has n-1 segments; a lone star has no figure.
    expect(figures).toHaveLength(2);
    for (const edge of figures) {
      expect(edge.fromKey.split(":")[0]).toBe(edge.toKey.split(":")[0]);
    }
  });

  it("draws a connector for every dependency whose other end is in the sky", () => {
    const layout = layoutStarMap(
      model([
        region("mac", [
          star("mac:base", { stage: "in-dev" }),
          star("mac:stacked", { dependsOnKeys: ["mac:base", "mac:gone"] }),
        ]),
      ]),
      SIZE,
    );

    const dependencies = layout.edges.filter((edge) => edge.kind === "dependency");
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]!.fromKey).toBe("mac:stacked");
    expect(dependencies[0]!.toKey).toBe("mac:base");
    expect(dependencies[0]!.d).toMatch(/^M .* Q .*$/);
  });

  it("traces the figures before the dependencies that cross them", () => {
    const layout = layoutStarMap(
      model([
        region("mac", [
          star("mac:base", { stage: "in-dev" }),
          star("mac:stacked", { dependsOnKeys: ["mac:base"] }),
        ]),
      ]),
      SIZE,
    );

    const orders = layout.edges.map((edge) => [edge.kind, edge.order] as const);
    expect(orders).toEqual([
      ["figure", 0],
      ["dependency", 1],
    ]);
  });

  it("hangs the moon only when an orchestrator is designated", () => {
    const withoutMaster = layoutStarMap(model([region("mac", [star("mac:a")])]), SIZE);
    expect(withoutMaster.moon).toBeNull();

    const withMaster = layoutStarMap(
      model([region("mac", [star("mac:a")])], {
        key: "mac:t-master",
        threadId: "t-master",
        environmentId: "mac",
        machineLabel: "mac",
        title: "Orchestrator",
        alive: false,
      }),
      SIZE,
    );
    expect(withMaster.moon!.y).toBeLessThan(withMaster.bands[3]!.top);
    expect(withMaster.moon!.x).toBeLessThan(SIZE.width);
  });

  it("gives every star a twinkle that is already under way and never in unison", () => {
    const layout = layoutStarMap(
      model([
        region(
          "mac",
          Array.from({ length: 12 }, (_, index) => star(`mac:t-${index}`)),
        ),
      ]),
      SIZE,
    );

    for (const placed of layout.stars) {
      expect(placed.twinklePeriodSeconds).toBeGreaterThanOrEqual(19);
      expect(placed.twinkleDelaySeconds).toBeLessThanOrEqual(0);
      expect(Math.abs(placed.twinkleDelaySeconds)).toBeLessThanOrEqual(placed.twinklePeriodSeconds);
    }
    expect(new Set(layout.stars.map((placed) => placed.twinkleDelaySeconds)).size).toBeGreaterThan(
      1,
    );
  });

  it("lays out an empty sky without producing stars or lines", () => {
    const layout = layoutStarMap(model([]), SIZE);
    expect(layout.stars).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.regions).toEqual([]);
    expect(layout.bands).toHaveLength(4);
  });

  it("holds a floor under a pane too small to draw a sky in", () => {
    const layout = layoutStarMap(model([region("mac", [star("mac:a")])]), {
      width: 40,
      height: 20,
    });
    expect(layout.width).toBeGreaterThanOrEqual(320);
    expect(layout.height).toBeGreaterThanOrEqual(320);
    expect(layout.stars[0]!.x).toBeGreaterThan(STAR_MAP_LAYOUT.gutterWidth);
  });
});
