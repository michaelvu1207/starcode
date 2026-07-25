import type { ProjectCategoryLocal, ProjectCategorySlug } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FeatureFlowView } from "../workbench/FeatureFlow.model";
import type { ProjectCategoryView, ProjectMembership } from "./ProjectCatalog.model";
import {
  buildProjectCards,
  projectAccentHue,
  projectGlyph,
  projectGlyphSeed,
  sortProjectCards,
  PROJECT_ACCENTS,
  PROJECT_GLYPH_VARIANTS,
  type ProjectCard,
  type ProjectRollupThread,
} from "./ProjectsIndex.model";

const slug = (value: string) => value as ProjectCategorySlug;

const local = (overrides?: Partial<ProjectCategoryLocal>): ProjectCategoryLocal => ({
  bindings: [],
  threadIds: [],
  excludedThreadIds: [],
  masterThreadId: "",
  masterDefaults: { runtimeMode: "approval-required", interactionMode: "plan" },
  defaults: {},
  updatedAt: "2026-07-25T00:00:00.000Z",
  ...overrides,
});

const project = (input: {
  readonly slug: string;
  readonly title?: string;
  readonly accent?: string;
  readonly glyph?: string;
  readonly archived?: boolean;
  readonly sections?: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly isLocal?: boolean;
    readonly local?: Partial<ProjectCategoryLocal>;
  }>;
}): ProjectCategoryView => ({
  slug: slug(input.slug),
  createdAt: "2026-07-01T00:00:00.000Z",
  display: {
    title: input.title ?? input.slug,
    summary: "",
    accent: input.accent ?? "",
    glyph: input.glyph ?? "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: input.archived === true ? "2026-07-20T00:00:00.000Z" : null,
    updatedAt: "2026-07-25T00:00:00.000Z",
  },
  archived: input.archived === true,
  sections: (input.sections ?? []).map((section) => ({
    environmentId: section.environmentId as never,
    label: section.label,
    isLocal: section.isLocal ?? false,
    local: local(section.local),
  })),
  staleEnvironmentIds: [],
});

const thread = (input: {
  readonly key: string;
  readonly status: ProjectRollupThread["status"];
  readonly updatedAt?: string;
  readonly settled?: boolean;
}): ProjectRollupThread => {
  const [environmentId, id] = input.key.split(":") as [string, string];
  return {
    environmentId,
    id,
    title: id,
    status: input.status,
    updatedAt: input.updatedAt ?? "2026-07-25T00:00:00.000Z",
    settled: input.settled ?? false,
  };
};

const membershipOf = (entries: Record<string, ReadonlyArray<string>>): ProjectMembership => ({
  slugByThreadKey: new Map(),
  threadKeysBySlug: new Map(
    Object.entries(entries).map(([key, value]) => [slug(key), value] as const),
  ),
  unfiledThreadKeys: [],
});

describe("buildProjectCards", () => {
  it("counts what is waiting on a human separately from what is running", () => {
    const [card] = buildProjectCards({
      projects: [project({ slug: "alpamayo" })],
      membership: membershipOf({ alpamayo: ["mac:t1", "mac:t2", "mac:t3"] }),
      threads: [
        thread({ key: "mac:t1", status: "approval" }),
        thread({ key: "mac:t2", status: "input" }),
        thread({ key: "mac:t3", status: "working" }),
      ],
      flow: null,
    });

    expect(card!.attentionCount).toBe(2);
    expect(card!.workingCount).toBe(1);
    expect(card!.activeCount).toBe(3);
  });

  it("puts a waiting agent ahead of a failure in the card's dot", () => {
    // Deliberate: the failure will still be there in a minute, and the waiting
    // agent will not have moved.
    const [card] = buildProjectCards({
      projects: [project({ slug: "alpamayo" })],
      membership: membershipOf({ alpamayo: ["mac:t1", "mac:t2"] }),
      threads: [
        thread({ key: "mac:t1", status: "failed" }),
        thread({ key: "mac:t2", status: "approval" }),
      ],
      flow: null,
    });
    expect(card!.tone).toBe("attention");
  });

  it("keeps settled threads out of the active count", () => {
    const [card] = buildProjectCards({
      projects: [project({ slug: "alpamayo" })],
      membership: membershipOf({ alpamayo: ["mac:t1", "mac:t2"] }),
      threads: [
        thread({ key: "mac:t1", status: "ready" }),
        thread({ key: "mac:t2", status: "ready", settled: true }),
      ],
      flow: null,
    });
    expect(card!.activeCount).toBe(1);
    expect(card!.settledCount).toBe(1);
  });

  it("takes last activity from every thread, settled ones included", () => {
    const [card] = buildProjectCards({
      projects: [project({ slug: "alpamayo" })],
      membership: membershipOf({ alpamayo: ["mac:t1", "mac:t2"] }),
      threads: [
        thread({ key: "mac:t1", status: "ready", updatedAt: "2026-07-20T00:00:00.000Z" }),
        thread({
          key: "mac:t2",
          status: "ready",
          settled: true,
          updatedAt: "2026-07-26T00:00:00.000Z",
        }),
      ],
      flow: null,
    });
    expect(card!.lastActivityAt).toBe("2026-07-26T00:00:00.000Z");
  });

  it("rolls up only this project's stages out of the fleet-wide flow", () => {
    const flow = {
      features: [
        { key: "mac:t1", stage: "in-dev" },
        { key: "mac:t2", stage: "in-production" },
        // Another project's feature, in the same unfiltered flow.
        { key: "mac:t9", stage: "in-staging" },
      ],
      unsupportedLabels: [],
      pendingLabels: [],
      diagnostics: [],
    } as unknown as FeatureFlowView;

    const [card] = buildProjectCards({
      projects: [project({ slug: "alpamayo" })],
      membership: membershipOf({ alpamayo: ["mac:t1", "mac:t2"] }),
      threads: [
        thread({ key: "mac:t1", status: "ready" }),
        thread({ key: "mac:t2", status: "ready" }),
      ],
      flow,
    });

    expect(card!.stages).toEqual({
      inProgress: 0,
      inDev: 1,
      inStaging: 0,
      inProduction: 1,
    });
  });

  it("marks a machine that only knows the name as carrying no work", () => {
    const [card] = buildProjectCards({
      projects: [
        project({
          slug: "alpamayo",
          sections: [
            { environmentId: "mac", label: "mac", local: { bindings: [] } },
            {
              environmentId: "pathpc",
              label: "path-pc",
              local: {
                bindings: [{ projectId: "p1" as never, boundAt: "2026-07-01T00:00:00.000Z" }],
              },
            },
          ],
        }),
      ],
      membership: membershipOf({}),
      threads: [],
      flow: null,
    });

    expect(card!.machines.map((machine) => [machine.label, machine.carriesWork])).toEqual([
      ["mac", false],
      ["path-pc", true],
    ]);
  });

  it("carries a chosen mark onto the card, so every surface draws the same project", () => {
    const [card] = buildProjectCards({
      projects: [project({ slug: "alpamayo", accent: "iris", glyph: "3" })],
      membership: membershipOf({}),
      threads: [],
      flow: null,
    });
    expect(card?.accent).toBe("iris");
    expect(card?.glyph).toBe("3");
  });

  it("reports an empty project without inventing threads for it", () => {
    const [card] = buildProjectCards({
      projects: [project({ slug: "reading" })],
      membership: membershipOf({}),
      threads: [],
      flow: null,
    });
    expect(card!.activeCount).toBe(0);
    expect(card!.tone).toBe("quiet");
    expect(card!.lastActivityAt).toBeNull();
  });
});

describe("sortProjectCards", () => {
  const card = (
    overrides: Omit<Partial<ProjectCard>, "slug"> & { readonly slug: string },
  ): ProjectCard => ({
    summary: "",
    accent: "",
    glyph: "",
    archived: false,
    machines: [],
    activeCount: 0,
    settledCount: 0,
    attentionCount: 0,
    workingCount: 0,
    tone: "quiet",
    stages: { inProgress: 0, inDev: 0, inStaging: 0, inProduction: 0 },
    lastActivityAt: null,
    staleEnvironmentIds: [],
    title: overrides.slug,
    ...overrides,
    slug: slug(overrides.slug),
  });

  it("reads whoever is waiting on you first, then what is moving", () => {
    const sorted = sortProjectCards([
      card({ slug: "quiet" }),
      card({ slug: "busy", workingCount: 3 }),
      card({ slug: "waiting", attentionCount: 1 }),
    ]);
    expect(sorted.map((entry) => entry.slug)).toEqual(["waiting", "busy", "quiet"]);
  });

  it("sinks archived projects below everything live, however busy they are", () => {
    const sorted = sortProjectCards([
      card({ slug: "old", archived: true, attentionCount: 9 }),
      card({ slug: "current" }),
    ]);
    expect(sorted.map((entry) => entry.slug)).toEqual(["current", "old"]);
  });

  it("falls back to recency, and then to a stable name order", () => {
    const sorted = sortProjectCards([
      card({ slug: "b" }),
      card({ slug: "a" }),
      card({ slug: "recent", lastActivityAt: "2026-07-26T00:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.slug)).toEqual(["recent", "a", "b"]);
  });
});

describe("projectGlyph", () => {
  it("is the same figure for the same slug, forever", () => {
    expect(projectGlyph("alpamayo")).toEqual(projectGlyph("alpamayo"));
    expect(projectAccentHue("alpamayo")).toBe(projectAccentHue("alpamayo"));
  });

  it("gives different projects different figures", () => {
    expect(projectGlyph("alpamayo")).not.toEqual(projectGlyph("arc-spirits"));
  });

  it("keeps every star inside its box, so nothing is ever clipped", () => {
    for (const name of ["a", "alpamayo", "arc-spirits", "simcloud-platform", "x-9"]) {
      for (const point of projectGlyph(name).points) {
        expect(point.x - point.r).toBeGreaterThan(0);
        expect(point.x + point.r).toBeLessThan(1);
        expect(point.y - point.r).toBeGreaterThan(0);
        expect(point.y + point.r).toBeLessThan(1);
      }
    }
  });

  it("draws a path through the stars rather than a mesh between them", () => {
    const glyph = projectGlyph("alpamayo");
    expect(glyph.edges).toHaveLength(glyph.points.length - 1);
  });

  it("stays legible: four to six stars, never one and never a dozen", () => {
    for (const name of ["a", "alpamayo", "arc-spirits", "simcloud-platform", "zzz", "x-9"]) {
      const count = projectGlyph(name).points.length;
      expect(count).toBeGreaterThanOrEqual(4);
      expect(count).toBeLessThanOrEqual(6);
    }
  });

  it("keeps the accent inside a full turn of hue", () => {
    for (const name of ["a", "alpamayo", "arc-spirits", "simcloud-platform"]) {
      const hue = projectAccentHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(360);
    }
  });

  it("honours a chosen accent, and derives one from the slug when there is none", () => {
    const chosen = PROJECT_ACCENTS[3]!;
    expect(projectAccentHue("alpamayo", chosen.id)).toBe(chosen.hue);
    expect(projectAccentHue("alpamayo", "")).toBe(projectAccentHue("alpamayo"));
  });

  it("falls back to the derived accent rather than to grey for an id it does not know", () => {
    // A newer client could write an accent this build has never heard of. That
    // is not a reason to render the project as though it had no identity.
    expect(projectAccentHue("alpamayo", "ultraviolet")).toBe(projectAccentHue("alpamayo"));
  });

  it("draws a different figure per variant, and the slug's own for the default", () => {
    expect(projectGlyphSeed("alpamayo", "")).toBe("alpamayo");
    expect(projectGlyph(projectGlyphSeed("alpamayo", ""))).toEqual(projectGlyph("alpamayo"));

    const figures = PROJECT_GLYPH_VARIANTS.map((variant) =>
      JSON.stringify(projectGlyph(projectGlyphSeed("alpamayo", variant))),
    );
    expect(new Set(figures).size).toBe(PROJECT_GLYPH_VARIANTS.length);
  });

  it("keeps every variant legible and inside its box, not just the default", () => {
    for (const variant of PROJECT_GLYPH_VARIANTS) {
      const glyph = projectGlyph(projectGlyphSeed("simcloud-platform", variant));
      expect(glyph.points.length).toBeGreaterThanOrEqual(4);
      expect(glyph.points.length).toBeLessThanOrEqual(6);
      for (const point of glyph.points) {
        expect(point.x - point.r).toBeGreaterThan(0);
        expect(point.x + point.r).toBeLessThan(1);
      }
    }
  });
});
