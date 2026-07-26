import {
  EnvironmentId,
  ProjectId,
  type ProjectCategoryLocal,
  type ProjectCategorySlug,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectCategoryView } from "./ProjectCatalog.model";
import {
  flattenProjectStartConnections,
  resolveProjectStartConnections,
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
  title = "Atlas",
): ProjectCategoryView => ({
  slug: "atlas" as ProjectCategorySlug,
  createdAt: "2026-07-01T00:00:00.000Z",
  display: {
    title,
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

const flatIds = (connections: ReturnType<typeof resolveProjectStartConnections>) =>
  flattenProjectStartConnections(connections).map((location) => location.projectId);

describe("resolveProjectStartConnections", () => {
  it("offers only the folders this project claims, never the ones it does not", () => {
    const connections = resolveProjectStartConnections({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-bound"] }]),
      folders: [folder("p-other", LOCAL, "Aardvark"), folder("p-bound", LOCAL, "Zebra")],
    });

    // "Aardvark" leads alphabetically and is a perfectly good folder. It is not
    // this project's, so starting a thread there is not one of the answers.
    expect(flatIds(connections)).toEqual(["p-bound"]);
  });

  it("groups the folders it offers under the machine they are on", () => {
    const connections = resolveProjectStartConnections({
      project: project([
        { environmentId: LAPTOP, boundProjectIds: ["p-remote"] },
        { environmentId: LOCAL, boundProjectIds: ["p-here"] },
      ]),
      folders: [folder("p-remote", LAPTOP, "Aardvark"), folder("p-here", LOCAL, "Zebra")],
    });

    expect(connections.map((connection) => connection.environmentId)).toEqual([LOCAL, LAPTOP]);
    expect(connections[0]?.locations.map((location) => location.projectId)).toEqual(["p-here"]);
    expect(connections[1]?.locations.map((location) => location.projectId)).toEqual(["p-remote"]);
  });

  it("lists every bound folder a single machine holds", () => {
    const connections = resolveProjectStartConnections({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-b", "p-a"] }]),
      folders: [folder("p-b", LOCAL, "Zebra"), folder("p-a", LOCAL, "Aardvark")],
    });

    expect(connections).toHaveLength(1);
    expect(connections[0]?.locations.map((location) => location.title)).toEqual([
      "Aardvark",
      "Zebra",
    ]);
  });

  it("scopes a binding to its own machine", () => {
    // Two machines can hold folders with the same project id; a binding
    // recorded on one says nothing about the other. The laptop's copy is not
    // bound, so this project has no bound folder anywhere and falls back to
    // offering the laptop as a default rather than as a claim.
    const connections = resolveProjectStartConnections({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-1"] }]),
      folders: [folder("p-1", LAPTOP, "Same id, other machine")],
    });

    expect(flattenProjectStartConnections(connections)[0]?.bound).toBe(false);
  });

  it("drops a binding whose folder the machine no longer reports", () => {
    const connections = resolveProjectStartConnections({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-gone", "p-here"] }]),
      folders: [folder("p-here", LOCAL, "Still here")],
    });

    expect(flatIds(connections)).toEqual(["p-here"]);
  });

  describe("a project that has claimed no folder anywhere", () => {
    it("offers every connection rather than leaving it with nowhere to go", () => {
      const connections = resolveProjectStartConnections({
        project: project([]),
        folders: [
          folder("p-laptop", LAPTOP, "Anything"),
          folder("p-local", LOCAL, "Anything else"),
        ],
      });

      expect(connections.map((connection) => connection.environmentId)).toEqual([LOCAL, LAPTOP]);
      expect(flatIds(connections)).toEqual(["p-local", "p-laptop"]);
    });

    it("offers exactly one folder per connection, not the machine's whole list", () => {
      const connections = resolveProjectStartConnections({
        project: project([]),
        folders: [
          folder("p-1", LOCAL, "Alpha"),
          folder("p-2", LOCAL, "Beta"),
          folder("p-3", LOCAL, "Gamma"),
        ],
      });

      expect(flatIds(connections)).toEqual(["p-1"]);
    });

    it("defaults to the folder named after the project when a machine has one", () => {
      // Every rival here sorts ahead of the match, so only the name rule can
      // produce this answer — alphabetical order alone would pick the others.
      const connections = resolveProjectStartConnections({
        project: project([], "Atlas"),
        folders: [
          folder("p-first", LOCAL, "Aardvark"),
          folder("p-match", LOCAL, "atlas"),
          folder("p-remote-first", LAPTOP, "Aardvark"),
          folder("p-remote-match", LAPTOP, "Atlas"),
        ],
      });

      expect(flatIds(connections)).toEqual(["p-match", "p-remote-match"]);
    });

    it("matches that name through case and separators", () => {
      // "Agent Hub" is the checkout called `agent-hub`. Comparing the strings
      // as written finds nothing and the alphabetical fallback wins instead.
      const connections = resolveProjectStartConnections({
        project: project([], "Agent Hub"),
        folders: [folder("p-first", LOCAL, "AAA tools"), folder("p-match", LOCAL, "agent-hub")],
      });

      expect(flatIds(connections)).toEqual(["p-match"]);
    });

    it("falls back to the first folder by name when nothing matches the project", () => {
      // Arbitrary, but the same answer every render — the operator is about to
      // read where their thread lives off this row.
      const connections = resolveProjectStartConnections({
        project: project([], "Atlas"),
        folders: [folder("p-last", LOCAL, "Zebra"), folder("p-first", LOCAL, "Aardvark")],
      });

      expect(flatIds(connections)).toEqual(["p-first"]);
    });

    it("marks its offers as unclaimed, so the picker can say so", () => {
      const connections = resolveProjectStartConnections({
        project: project([]),
        folders: [folder("p-1", LOCAL, "Anything")],
      });

      expect(flattenProjectStartConnections(connections)[0]?.bound).toBe(false);
    });
  });

  it("offers nothing at all when no machine reports a folder", () => {
    expect(resolveProjectStartConnections({ project: project([]), folders: [] })).toHaveLength(0);
  });
});

describe("resolveUnambiguousStartLocation", () => {
  it("starts without asking when the project claims exactly one folder", () => {
    const connections = resolveProjectStartConnections({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-bound"] }]),
      folders: [folder("p-bound", LOCAL, "Zebra"), folder("p-other", LOCAL, "Aardvark")],
    });

    expect(resolveUnambiguousStartLocation(connections)?.projectId).toBe("p-bound");
  });

  it("asks when the project claims several folders on one machine", () => {
    const connections = resolveProjectStartConnections({
      project: project([{ environmentId: LOCAL, boundProjectIds: ["p-a", "p-b"] }]),
      folders: [folder("p-a", LOCAL, "A"), folder("p-b", LOCAL, "B")],
    });

    expect(resolveUnambiguousStartLocation(connections)).toBeNull();
  });

  it("asks when the project claims one folder on each of two machines", () => {
    const connections = resolveProjectStartConnections({
      project: project([
        { environmentId: LOCAL, boundProjectIds: ["p-here"] },
        { environmentId: LAPTOP, boundProjectIds: ["p-remote"] },
      ]),
      folders: [folder("p-here", LOCAL, "A"), folder("p-remote", LAPTOP, "B")],
    });

    expect(resolveUnambiguousStartLocation(connections)).toBeNull();
  });

  it("asks when the project claims none, however few folders exist", () => {
    // The thread is about to land somewhere this project has never claimed.
    // One candidate is not the same as no decision.
    const connections = resolveProjectStartConnections({
      project: project([]),
      folders: [folder("p-1", LOCAL, "Only one")],
    });

    expect(resolveUnambiguousStartLocation(connections)).toBeNull();
  });
});
