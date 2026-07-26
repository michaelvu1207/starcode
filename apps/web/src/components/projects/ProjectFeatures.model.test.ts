/**
 * The cross-machine feature fold.
 *
 * These pin the three things the doctrine actually asks of it: that a feature
 * created on one machine is visible from another, that nothing is merged across
 * machines, and that the answer does not depend on which machine happened to
 * answer first.
 */
import { ProjectCategorySlug, ThreadId, type FeatureMapEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SkyMachineMap } from "../workbench/StarMap.model";
import { describeProjectFeatures, foldProjectFeatures } from "./ProjectFeatures.model";

const atlas = ProjectCategorySlug.make("atlas");
const beacon = ProjectCategorySlug.make("beacon");

const entry = (id: string, overrides?: Partial<FeatureMapEntry>): FeatureMapEntry =>
  ({
    id,
    name: id,
    description: null,
    threadId: null,
    slug: null,
    stage: "in-progress",
    dependsOn: [],
    planned: false,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  }) as FeatureMapEntry;

const machines = (
  ...entries: ReadonlyArray<readonly [string, string, ReadonlyArray<FeatureMapEntry>]>
): ReadonlyMap<string, SkyMachineMap> =>
  new Map(entries.map(([environmentId, label, list]) => [environmentId, { label, entries: list }]));

/** A scope claiming exactly the given `environmentId:threadId` keys. */
const scopeOver = (...keys: ReadonlyArray<string>) => {
  const claimed = new Set(keys);
  return { slug: atlas, includeThreadKey: (key: string) => claimed.has(key) };
};

describe("foldProjectFeatures", () => {
  it("shows a master on one machine what it created on another", () => {
    // The gap this exists to close: one registry file per server, and
    // project_get answers only about the machine it runs on.
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines(
        ["env-mac", "mac", [entry("aaaaaaaaaaaa", { name: "Here", slug: atlas })]],
        ["env-sf1", "simforge1", [entry("bbbbbbbbbbbb", { name: "There", slug: atlas })]],
      ),
      scope: scopeOver(),
    });

    expect(rollup.features.map((feature) => feature.entry.name)).toEqual(["Here", "There"]);
    expect(rollup.machines).toEqual([
      { environmentId: "env-mac", label: "mac", count: 1 },
      { environmentId: "env-sf1", label: "simforge1", count: 1 },
    ]);
  });

  it("keeps another project's features out", () => {
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines([
        "env-mac",
        "mac",
        [
          entry("aaaaaaaaaaaa", { name: "Ours", slug: atlas }),
          entry("bbbbbbbbbbbb", { name: "Theirs", slug: beacon }),
        ],
      ]),
      scope: scopeOver(),
    });

    expect(rollup.features.map((feature) => feature.entry.name)).toEqual(["Ours"]);
  });

  it("does not merge two machines' identically named features", () => {
    // Two rows authored independently are two features. Collapsing them would
    // be the client guessing, and a wrong guess hides one of them silently.
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines(
        ["env-mac", "mac", [entry("aaaaaaaaaaaa", { name: "Star map", slug: atlas })]],
        ["env-sf1", "simforge1", [entry("bbbbbbbbbbbb", { name: "Star map", slug: atlas })]],
      ),
      scope: scopeOver(),
    });

    expect(rollup.features).toHaveLength(2);
    expect(new Set(rollup.features.map((feature) => feature.key)).size).toBe(2);
  });

  it("gathers an unfiled feature through the thread the project claims", () => {
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines([
        "env-sf1",
        "simforge1",
        [entry("aaaaaaaaaaaa", { name: "Inherited", threadId: ThreadId.make("t-1") })],
      ]),
      scope: scopeOver("env-sf1:t-1"),
    });

    expect(rollup.features.map((feature) => feature.entry.name)).toEqual(["Inherited"]);
  });

  it("scopes the thread fallback to the machine that holds the entry", () => {
    // Thread ids are machine-scoped, so `t-1` on the Mac and `t-1` on simforge1
    // are unrelated strings that can collide.
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines([
        "env-sf1",
        "simforge1",
        [entry("aaaaaaaaaaaa", { threadId: ThreadId.make("t-1") })],
      ]),
      scope: scopeOver("env-mac:t-1"),
    });

    expect(rollup.features).toEqual([]);
  });

  it("counts stages without letting the plan into them", () => {
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines([
        "env-mac",
        "mac",
        [
          entry("aaaaaaaaaaaa", { slug: atlas, stage: "in-dev" }),
          entry("bbbbbbbbbbbb", { slug: atlas, stage: "in-dev" }),
          entry("cccccccccccc", { slug: atlas, stage: "in-production" }),
          entry("dddddddddddd", { slug: atlas, planned: true, stage: "in-dev" }),
        ],
      ]),
      scope: scopeOver(),
    });

    expect(rollup.realCount).toBe(3);
    expect(rollup.plannedCount).toBe(1);
    // Lowest stage first, and a stage nothing reached is absent rather than zero.
    expect(rollup.byStage).toEqual([
      { stage: "in-dev", count: 2 },
      { stage: "in-production", count: 1 },
    ]);
  });

  it("gives the same answer whichever machine answered first", () => {
    const mac = ["env-mac", "mac", [entry("bbbbbbbbbbbb", { slug: atlas })]] as const;
    const sf1 = ["env-sf1", "simforge1", [entry("aaaaaaaaaaaa", { slug: atlas })]] as const;

    const forwards = foldProjectFeatures({
      mapEntriesByEnvironment: machines(mac, sf1),
      scope: scopeOver(),
    });
    const backwards = foldProjectFeatures({
      mapEntriesByEnvironment: machines(sf1, mac),
      scope: scopeOver(),
    });

    expect(forwards).toEqual(backwards);
  });

  it("says nothing about a project no machine has filed a feature under", () => {
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines(["env-mac", "mac", []]),
      scope: scopeOver(),
    });

    expect(rollup.features).toEqual([]);
    expect(describeProjectFeatures(rollup)).toBeNull();
  });
});

describe("describeProjectFeatures", () => {
  it("reads as one sentence beside the sky, not a second picture of it", () => {
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines([
        "env-mac",
        "mac",
        [
          entry("aaaaaaaaaaaa", { slug: atlas, stage: "in-dev" }),
          entry("bbbbbbbbbbbb", { slug: atlas, stage: "in-production" }),
          entry("cccccccccccc", { slug: atlas, planned: true }),
        ],
      ]),
      scope: scopeOver(),
    });

    expect(describeProjectFeatures(rollup)).toBe("2 features · 1 landed · 1 shipped · 1 planned");
  });

  it("admits when a machine did not say what it holds", () => {
    // A count that is quietly short is worse than one that says so. "Did not
    // answer" is not "answered none".
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines([
        "env-mac",
        "mac",
        [entry("aaaaaaaaaaaa", { slug: atlas })],
      ]),
      scope: scopeOver(),
    });

    expect(describeProjectFeatures(rollup, ["simforge1"])).toBe(
      "1 feature · 1 in flight · could not read simforge1",
    );
  });

  it("says so even when the fold found nothing at all", () => {
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines(["env-mac", "mac", []]),
      scope: scopeOver(),
    });

    expect(describeProjectFeatures(rollup, ["simforge1", "path-pc"])).toBe(
      "could not read path-pc, simforge1",
    );
  });

  it("keeps the singular singular", () => {
    const rollup = foldProjectFeatures({
      mapEntriesByEnvironment: machines([
        "env-mac",
        "mac",
        [entry("aaaaaaaaaaaa", { slug: atlas })],
      ]),
      scope: scopeOver(),
    });

    expect(describeProjectFeatures(rollup)).toBe("1 feature · 1 in flight");
  });
});
