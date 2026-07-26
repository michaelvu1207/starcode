import {
  EnvironmentId,
  ProjectId,
  type ProjectCategoryLocal,
  type ProjectCategorySlug,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectCategoryView } from "./ProjectCatalog.model";
import {
  resolveProjectStartLocations,
  resolveUnambiguousStartLocation,
  type ProjectStartFolder,
} from "./ProjectThreadStart.model";

const LOCAL = EnvironmentId.make("env-local");
const LAPTOP = EnvironmentId.make("env-laptop");

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

const project = (
  sections: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly boundProjectIds: ReadonlyArray<string>;
  }>,
): ProjectCategoryView => ({
  slug: "atlas" as ProjectCategorySlug,
  createdAt: "2026-07-01T00:00:00.000Z",
  display: {
    title: "Atlas",
    summary: "",
    accent: "",
    glyph: "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: null,
    updatedAt: "2026-07-25T00:00:00.000Z",
  },
  archived: false,
  sections: sections.map((section) => ({
    environmentId: section.environmentId,
    label: section.environmentId,
    isLocal: section.environmentId === LOCAL,
    local: local({
      bindings: section.boundProjectIds.map((id) => ({
        projectId: ProjectId.make(id),
        boundAt: "2026-07-20T00:00:00.000Z",
      })),
    }),
  })),
  staleEnvironmentIds: [],
});

const folder = (id: string, environmentId: EnvironmentId, title: string): ProjectStartFolder => ({
  environmentId,
  projectId: ProjectId.make(id),
  title,
  machineLabel: environmentId,
  isLocalMachine: environmentId === LOCAL,
});

describe("resolveProjectStartLocations", () => {
  it("puts the folders this project claims ahead of the ones it does not", () => {
    const locations = resolveProjectStartLocations({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-bound"] }]),
      folders: [folder("p-other", LOCAL, "Aardvark"), folder("p-bound", LOCAL, "Zebra")],
    });

    // Alphabetically "Aardvark" leads, but it is not this project's folder.
    expect(locations.map((location) => location.projectId)).toEqual(["p-bound", "p-other"]);
    expect(locations[0]?.bound).toBe(true);
    expect(locations[1]?.bound).toBe(false);
  });

  it("prefers this machine among equally bound folders", () => {
    const locations = resolveProjectStartLocations({
      project: project([
        { environmentId: LAPTOP, boundProjectIds: ["p-remote"] },
        { environmentId: LOCAL, boundProjectIds: ["p-here"] },
      ]),
      folders: [folder("p-remote", LAPTOP, "Aardvark"), folder("p-here", LOCAL, "Zebra")],
    });

    expect(locations.map((location) => location.projectId)).toEqual(["p-here", "p-remote"]);
  });

  it("scopes a binding to its own machine", () => {
    // Two machines can hold folders with the same project id; a binding
    // recorded on one says nothing about the other.
    const locations = resolveProjectStartLocations({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-1"] }]),
      folders: [folder("p-1", LAPTOP, "Same id, other machine")],
    });

    expect(locations[0]?.bound).toBe(false);
  });

  it("drops a binding whose folder the machine no longer reports", () => {
    const locations = resolveProjectStartLocations({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-gone"] }]),
      folders: [folder("p-here", LOCAL, "Still here")],
    });

    expect(locations.map((location) => location.projectId)).toEqual(["p-here"]);
  });

  it("offers unbound folders rather than leaving a fresh project with nowhere to go", () => {
    const locations = resolveProjectStartLocations({
      project: project([]),
      folders: [folder("p-1", LOCAL, "Anything")],
    });

    expect(locations).toHaveLength(1);
    expect(locations[0]?.bound).toBe(false);
  });
});

describe("resolveUnambiguousStartLocation", () => {
  it("starts without asking when the project claims exactly one folder", () => {
    const locations = resolveProjectStartLocations({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-bound"] }]),
      folders: [folder("p-bound", LOCAL, "Zebra"), folder("p-other", LOCAL, "Aardvark")],
    });

    expect(resolveUnambiguousStartLocation(locations)?.projectId).toBe("p-bound");
  });

  it("asks when the project claims several folders", () => {
    const locations = resolveProjectStartLocations({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-a", "p-b"] }]),
      folders: [folder("p-a", LOCAL, "A"), folder("p-b", LOCAL, "B")],
    });

    expect(resolveUnambiguousStartLocation(locations)).toBeNull();
  });

  it("asks when the project claims none, however few folders exist", () => {
    // The thread is about to land somewhere this project has never claimed.
    // One candidate is not the same as no decision.
    const locations = resolveProjectStartLocations({
      project: project([]),
      folders: [folder("p-1", LOCAL, "Only one")],
    });

    expect(resolveUnambiguousStartLocation(locations)).toBeNull();
  });
});
