import type {
  EnvironmentId,
  ProjectCategoryLocal,
  ProjectCategoryRecord,
  ProjectCategorySlug,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkbenchMaster } from "../workbench/Workbench.master";
import {
  applyPendingProjectDisplays,
  buildProjectCatalogView,
  PENDING_PROJECT_CREATE_GRACE_MS,
  buildProjectSeedPlan,
  projectMasterCandidates,
  projectThreadKey,
  resolveProjectMembership,
  type ProjectCatalogEnvironmentInput,
  type ProjectSeedLocation,
} from "./ProjectCatalog.model";

const env = (value: string) => value as EnvironmentId;
const slug = (value: string) => value as ProjectCategorySlug;
const thread = (value: string) => value as ThreadId;
const project = (value: string) => value as ProjectId;

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

const record = (input: {
  readonly slug: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly createdAt?: string;
  readonly archivedAt?: string | null;
  readonly local?: Partial<ProjectCategoryLocal>;
}): ProjectCategoryRecord => ({
  slug: slug(input.slug),
  createdAt: input.createdAt ?? "2026-07-01T00:00:00.000Z",
  display: {
    title: input.title ?? input.slug,
    summary: "",
    accent: "",
    glyph: "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: input.archivedAt ?? null,
    updatedAt: input.updatedAt ?? "2026-07-25T00:00:00.000Z",
  },
  local: local(input.local),
});

const machine = (input: {
  readonly environmentId: string;
  readonly label?: string;
  readonly isLocal?: boolean;
  readonly categories?: ReadonlyArray<ProjectCategoryRecord>;
  readonly supported?: boolean;
  readonly pending?: boolean;
}): ProjectCatalogEnvironmentInput => ({
  environmentId: env(input.environmentId),
  label: input.label ?? input.environmentId,
  isLocal: input.isLocal ?? false,
  snapshot:
    input.categories === undefined
      ? null
      : { categories: input.categories, computedAt: "2026-07-25T00:00:00.000Z" },
  supported: input.supported ?? true,
  pending: input.pending ?? false,
});

describe("buildProjectCatalogView", () => {
  it("unions the same slug across machines into one project", () => {
    const view = buildProjectCatalogView([
      machine({ environmentId: "mac", isLocal: true, categories: [record({ slug: "alpamayo" })] }),
      machine({ environmentId: "pathpc", categories: [record({ slug: "alpamayo" })] }),
      machine({ environmentId: "simforge1", categories: [record({ slug: "alpamayo" })] }),
    ]);

    expect(view.projects).toHaveLength(1);
    expect(view.projects[0]!.sections.map((section) => section.environmentId)).toEqual([
      "mac",
      "pathpc",
      "simforge1",
    ]);
  });

  it("produces the identical view whatever order the machines answer in", () => {
    const machines = [
      machine({
        environmentId: "mac",
        isLocal: true,
        categories: [record({ slug: "alpamayo", title: "Alpamayo" })],
      }),
      machine({
        environmentId: "pathpc",
        categories: [
          record({
            slug: "alpamayo",
            title: "Alpamayo Pipeline",
            updatedAt: "2026-07-26T00:00:00.000Z",
          }),
        ],
      }),
      machine({ environmentId: "laptop", categories: [record({ slug: "arc-spirits" })] }),
    ];

    const forward = buildProjectCatalogView(machines);
    const backward = buildProjectCatalogView(machines.toReversed());
    expect(backward).toEqual(forward);
  });

  it("gives the newest title, and names the machines that are behind", () => {
    const view = buildProjectCatalogView([
      machine({
        environmentId: "mac",
        isLocal: true,
        categories: [
          record({ slug: "alpamayo", title: "Alpamayo", updatedAt: "2026-07-20T00:00:00.000Z" }),
        ],
      }),
      machine({
        environmentId: "pathpc",
        categories: [
          record({
            slug: "alpamayo",
            title: "Alpamayo Pipeline",
            updatedAt: "2026-07-26T00:00:00.000Z",
          }),
        ],
      }),
    ]);

    expect(view.projects[0]!.display.title).toBe("Alpamayo Pipeline");
    expect(view.projects[0]!.staleEnvironmentIds).toEqual(["mac"]);
  });

  it("breaks an exact updatedAt tie on environment id rather than on read order", () => {
    const tied = [
      machine({
        environmentId: "zulu",
        categories: [record({ slug: "alpamayo", title: "From Zulu" })],
      }),
      machine({
        environmentId: "alpha",
        categories: [record({ slug: "alpamayo", title: "From Alpha" })],
      }),
    ];
    expect(buildProjectCatalogView(tied).projects[0]!.display.title).toBe("From Alpha");
    expect(buildProjectCatalogView(tied.toReversed()).projects[0]!.display.title).toBe(
      "From Alpha",
    );
  });

  it("takes the earliest creation time across machines", () => {
    const view = buildProjectCatalogView([
      machine({
        environmentId: "mac",
        categories: [record({ slug: "alpamayo", createdAt: "2026-07-10T00:00:00.000Z" })],
      }),
      machine({
        environmentId: "pathpc",
        categories: [record({ slug: "alpamayo", createdAt: "2026-07-02T00:00:00.000Z" })],
      }),
    ]);
    expect(view.projects[0]!.createdAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("keeps a project a machine holds even while another machine is offline", () => {
    const view = buildProjectCatalogView([
      machine({ environmentId: "mac", isLocal: true, categories: [record({ slug: "alpamayo" })] }),
      machine({ environmentId: "laptop", pending: true }),
    ]);

    expect(view.projects).toHaveLength(1);
    expect(view.notes).toEqual([{ environmentId: "laptop", label: "laptop", reason: "pending" }]);
  });

  it("tells an old server apart from an unreachable one", () => {
    const view = buildProjectCatalogView([
      // Connected, and its server does not advertise the capability: a machine
      // mid-rollout, which the view names rather than hides.
      machine({ environmentId: "old", supported: false }),
      // Connected, advertises the capability, still did not answer — the only
      // one of the three worth investigating.
      machine({ environmentId: "broken", supported: true }),
      machine({ environmentId: "asleep", pending: true }),
    ]);

    expect(view.notes.map((note) => [note.environmentId, note.reason])).toEqual([
      ["asleep", "pending"],
      ["broken", "unreadable"],
      ["old", "unsupported"],
    ]);
  });

  it("keeps a category with no bindings anywhere", () => {
    // Michael's "not folder-related" case: a research project whose threads
    // live in scratch dirs and are filed by hand.
    const view = buildProjectCatalogView([
      machine({
        environmentId: "mac",
        categories: [record({ slug: "reading", local: { threadIds: [thread("t1")] } })],
      }),
    ]);
    expect(view.projects[0]!.slug).toBe("reading");
    expect(view.projects[0]!.sections[0]!.local.bindings).toEqual([]);
  });
});

describe("resolveProjectMembership", () => {
  const viewOf = (machines: ReadonlyArray<ProjectCatalogEnvironmentInput>) =>
    buildProjectCatalogView(machines).projects;

  it("files a thread by its location, with nothing filed by hand", () => {
    const projects = viewOf([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "alpamayo",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
            },
          }),
        ],
      }),
    ]);

    const membership = resolveProjectMembership({
      projects,
      threads: [{ environmentId: env("mac"), id: thread("t1"), projectId: project("p1") }],
    });

    expect(membership.slugByThreadKey.get("mac:t1")).toBe("alpamayo");
    expect(membership.unfiledThreadKeys).toEqual([]);
  });

  it("lets an explicit add override the location the thread actually sits in", () => {
    const projects = viewOf([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "alpamayo",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
            },
          }),
          record({ slug: "reading", local: { threadIds: [thread("t1")] } }),
        ],
      }),
    ]);

    const membership = resolveProjectMembership({
      projects,
      threads: [{ environmentId: env("mac"), id: thread("t1"), projectId: project("p1") }],
    });

    // One project per thread: the explicit filing wins outright rather than
    // the thread appearing in both skies.
    expect(membership.slugByThreadKey.get("mac:t1")).toBe("reading");
    expect([...(membership.threadKeysBySlug.get(slug("alpamayo")) ?? [])]).toEqual([]);
    expect([...(membership.threadKeysBySlug.get(slug("reading")) ?? [])]).toEqual(["mac:t1"]);
  });

  it("takes a bound thread out when this machine excludes it", () => {
    const projects = viewOf([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "alpamayo",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
              excludedThreadIds: [thread("t1")],
            },
          }),
        ],
      }),
    ]);

    const membership = resolveProjectMembership({
      projects,
      threads: [{ environmentId: env("mac"), id: thread("t1"), projectId: project("p1") }],
    });

    expect(membership.slugByThreadKey.has("mac:t1")).toBe(false);
    expect(membership.unfiledThreadKeys).toEqual(["mac:t1"]);
  });

  it("lets an explicit add beat an exclusion on the same category", () => {
    // Reachable when two machines edited while one was offline. The registry
    // retracts the exclusion on assign; the fold must not need it to have.
    const projects = viewOf([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "alpamayo",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
              threadIds: [thread("t1")],
              excludedThreadIds: [thread("t1")],
            },
          }),
        ],
      }),
    ]);

    const membership = resolveProjectMembership({
      projects,
      threads: [{ environmentId: env("mac"), id: thread("t1"), projectId: project("p1") }],
    });
    expect(membership.slugByThreadKey.get("mac:t1")).toBe("alpamayo");
  });

  it("never lets one machine's ids speak for another's", () => {
    // Same ProjectId string on two machines, bound to two different categories:
    // unrelated values that happen to collide, and a fold that keyed on the id
    // alone would file both threads into whichever it saw last.
    const projects = viewOf([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "alpamayo",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
            },
          }),
        ],
      }),
      machine({
        environmentId: "pathpc",
        categories: [
          record({
            slug: "arc-spirits",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
            },
          }),
        ],
      }),
    ]);

    const membership = resolveProjectMembership({
      projects,
      threads: [
        { environmentId: env("mac"), id: thread("t1"), projectId: project("p1") },
        { environmentId: env("pathpc"), id: thread("t1"), projectId: project("p1") },
      ],
    });

    expect(membership.slugByThreadKey.get("mac:t1")).toBe("alpamayo");
    expect(membership.slugByThreadKey.get("pathpc:t1")).toBe("arc-spirits");
  });

  it("reports a thread in no category as unfiled", () => {
    const membership = resolveProjectMembership({
      projects: viewOf([
        machine({ environmentId: "mac", categories: [record({ slug: "alpamayo" })] }),
      ]),
      threads: [{ environmentId: env("mac"), id: thread("t9"), projectId: project("p9") }],
    });
    expect(membership.unfiledThreadKeys).toEqual(["mac:t9"]);
  });

  it("can leave archived projects' threads unfiled when the caller asks", () => {
    const projects = viewOf([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "alpamayo",
            archivedAt: "2026-07-24T00:00:00.000Z",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
            },
          }),
        ],
      }),
    ]);
    const threads = [{ environmentId: env("mac"), id: thread("t1"), projectId: project("p1") }];

    expect(resolveProjectMembership({ projects, threads }).slugByThreadKey.get("mac:t1")).toBe(
      "alpamayo",
    );
    expect(
      resolveProjectMembership({ projects, threads, includeArchived: false }).unfiledThreadKeys,
    ).toEqual(["mac:t1"]);
  });

  it("keys threads the way the caller is told to", () => {
    expect(projectThreadKey({ environmentId: env("mac"), id: thread("t1") })).toBe("mac:t1");
  });
});

describe("projectMasterCandidates", () => {
  it("resolves a per-project master local-first, with the rest as alternates", () => {
    const [project0] = buildProjectCatalogView([
      machine({
        environmentId: "pathpc",
        label: "path-pc",
        categories: [record({ slug: "alpamayo", local: { masterThreadId: "remote-master" } })],
      }),
      machine({
        environmentId: "mac",
        label: "mac",
        isLocal: true,
        categories: [record({ slug: "alpamayo", local: { masterThreadId: "local-master" } })],
      }),
    ]).projects;

    // Deliberately fed straight into the existing resolver: a per-project
    // master needs a different array, not a different function.
    const { designated, alternates } = resolveWorkbenchMaster(projectMasterCandidates(project0!));
    expect(designated?.threadId).toBe("local-master");
    expect(alternates.map((alternate) => alternate.threadId)).toEqual(["remote-master"]);
  });

  it("designates nothing when no machine names a master", () => {
    const [project0] = buildProjectCatalogView([
      machine({ environmentId: "mac", isLocal: true, categories: [record({ slug: "alpamayo" })] }),
    ]).projects;
    expect(resolveWorkbenchMaster(projectMasterCandidates(project0!)).designated).toBeNull();
  });
});

describe("buildProjectSeedPlan", () => {
  const location = (input: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly repositoryKey?: string | null;
    readonly repositoryName?: string | null;
    readonly boundSlug?: string | null;
  }): ProjectSeedLocation => ({
    environmentId: env(input.environmentId),
    label: input.environmentId,
    projectId: project(input.projectId),
    title: input.workspaceRoot,
    workspaceRoot: input.workspaceRoot,
    repositoryKey: input.repositoryKey ?? null,
    repositoryName: input.repositoryName ?? null,
    boundSlug: input.boundSlug == null ? null : slug(input.boundSlug),
  });

  it("withholds every suggestion for a machine whose catalog could not be read", () => {
    // Both outputs lead to a write that replaces a machine's whole binding set,
    // and the set to preserve is read from the fold. A machine that did not
    // answer contributes no section, so that read returns empty — and an empty
    // "existing" set is an erase. The locations page is a slower, separate
    // poll, so it happily keeps serving a machine whose catalog is failing.
    const plan = buildProjectSeedPlan({
      projects: [],
      locations: [
        location({ environmentId: "mac", projectId: "p1", workspaceRoot: "/Users/m/api" }),
        location({ environmentId: "laptop", projectId: "p2", workspaceRoot: "/home/m/api" }),
      ],
      silentEnvironmentIds: [env("laptop")],
    });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]!.locations.map((entry) => entry.environmentId)).toEqual(["mac"]);
  });

  it("withholds a bind suggestion for a machine whose catalog could not be read", () => {
    const plan = buildProjectSeedPlan({
      projects: buildProjectCatalogView([
        machine({ environmentId: "mac", categories: [record({ slug: "api" })] }),
      ]).projects,
      locations: [
        location({ environmentId: "laptop", projectId: "p2", workspaceRoot: "/home/m/api" }),
      ],
      silentEnvironmentIds: [env("laptop")],
    });

    expect(plan.bindSuggestions).toEqual([]);
    expect(plan.proposals).toEqual([]);
  });

  it("proposes one project per repository across every machine that has it", () => {
    const plan = buildProjectSeedPlan({
      projects: [],
      locations: [
        location({
          environmentId: "mac",
          projectId: "p1",
          workspaceRoot: "/Users/m/simcloud-platform",
          repositoryKey: "github.com/simforge/simcloud",
          repositoryName: "simcloud",
        }),
        location({
          environmentId: "simforge1",
          projectId: "p9",
          workspaceRoot: "/data/simcloud-platform",
          repositoryKey: "github.com/simforge/simcloud",
          repositoryName: "simcloud",
        }),
      ],
    });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]!.slug).toBe("simcloud");
    expect(plan.proposals[0]!.evidence).toBe("repository");
    expect(plan.proposals[0]!.locations.map((entry) => entry.environmentId)).toEqual([
      "mac",
      "simforge1",
    ]);
  });

  it("labels a basename-only match as weak instead of pretending it is a repository", () => {
    const plan = buildProjectSeedPlan({
      projects: [],
      locations: [
        location({ environmentId: "mac", projectId: "p1", workspaceRoot: "/Users/m/scratch/api" }),
        location({ environmentId: "laptop", projectId: "p2", workspaceRoot: "/home/m/work/api" }),
      ],
    });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]!.evidence).toBe("path");
  });

  it("ranks repository identity above the basename that disagrees with it", () => {
    const plan = buildProjectSeedPlan({
      projects: [],
      locations: [
        location({
          environmentId: "mac",
          projectId: "p1",
          workspaceRoot: "/Users/m/checkout",
          repositoryKey: "github.com/simforge/simcloud",
          repositoryName: "simcloud",
        }),
        location({ environmentId: "laptop", projectId: "p2", workspaceRoot: "/home/m/checkout" }),
      ],
    });

    // Two locations whose folders share a name but whose identities do not: two
    // proposals, not one merged project.
    expect(plan.proposals.map((proposal) => proposal.slug).toSorted()).toEqual([
      "checkout",
      "simcloud",
    ]);
  });

  it("suggests binding to a project that already exists rather than seeding a second one", () => {
    const projects = buildProjectCatalogView([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "simcloud",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
            },
          }),
        ],
      }),
    ]).projects;

    const plan = buildProjectSeedPlan({
      projects,
      locations: [
        location({
          environmentId: "mac",
          projectId: "p1",
          workspaceRoot: "/Users/m/simcloud-platform",
          repositoryKey: "github.com/simforge/simcloud",
          repositoryName: "simcloud",
          boundSlug: "simcloud",
        }),
        location({
          environmentId: "simforge1",
          projectId: "p9",
          workspaceRoot: "/data/simcloud-platform",
          repositoryKey: "github.com/simforge/simcloud",
          repositoryName: "simcloud",
        }),
      ],
    });

    expect(plan.proposals).toEqual([]);
    expect(plan.bindSuggestions).toHaveLength(1);
    expect(plan.bindSuggestions[0]!.slug).toBe("simcloud");
    expect(plan.bindSuggestions[0]!.evidence).toBe("repository");
    expect(plan.bindSuggestions[0]!.location.environmentId).toBe("simforge1");
  });

  it("proposes nothing the second time it runs", () => {
    const locations = [
      location({
        environmentId: "mac",
        projectId: "p1",
        workspaceRoot: "/Users/m/simcloud-platform",
        repositoryKey: "github.com/simforge/simcloud",
        repositoryName: "simcloud",
        boundSlug: "simcloud",
      }),
    ];
    const projects = buildProjectCatalogView([
      machine({
        environmentId: "mac",
        categories: [
          record({
            slug: "simcloud",
            local: {
              bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }],
            },
          }),
        ],
      }),
    ]).projects;

    const plan = buildProjectSeedPlan({ projects, locations });
    expect(plan.proposals).toEqual([]);
    expect(plan.bindSuggestions).toEqual([]);
  });

  it("suffixes rather than merges when two repositories share a name", () => {
    const plan = buildProjectSeedPlan({
      projects: [],
      locations: [
        location({
          environmentId: "mac",
          projectId: "p1",
          workspaceRoot: "/Users/m/a/api",
          repositoryKey: "github.com/one/api",
          repositoryName: "api",
        }),
        location({
          environmentId: "mac",
          projectId: "p2",
          workspaceRoot: "/Users/m/b/api",
          repositoryKey: "github.com/two/api",
          repositoryName: "api",
        }),
      ],
    });

    expect(plan.proposals.map((proposal) => proposal.slug).toSorted()).toEqual(["api", "api-2"]);
  });

  it("ignores locations that are already bound", () => {
    const plan = buildProjectSeedPlan({
      projects: [],
      locations: [
        location({
          environmentId: "mac",
          projectId: "p1",
          workspaceRoot: "/Users/m/simcloud",
          boundSlug: "simcloud",
        }),
      ],
    });
    expect(plan.proposals).toEqual([]);
    expect(plan.bindSuggestions).toEqual([]);
  });
});

describe("applyPendingProjectDisplays", () => {
  const viewOf = (categories: ReadonlyArray<ProjectCategoryRecord>) =>
    buildProjectCatalogView([machine({ environmentId: "mac", isLocal: true, categories })]);

  it("shows a rename before any machine has reported it back", () => {
    const view = applyPendingProjectDisplays(
      viewOf([
        record({ slug: "alpamayo", title: "Alpamayo", updatedAt: "2026-07-25T00:00:00.000Z" }),
      ]),
      [
        {
          slug: slug("alpamayo"),
          display: { title: "Alpamayo Pipeline" },
          stamp: "2026-07-26T00:00:00.000Z",
          created: false,
        },
      ],
    );
    expect(view.projects[0]!.display.title).toBe("Alpamayo Pipeline");
  });

  it("drops the overlay the moment the read catches up", () => {
    const view = applyPendingProjectDisplays(
      viewOf([
        record({
          slug: "alpamayo",
          title: "Alpamayo Pipeline",
          updatedAt: "2026-07-26T00:00:00.000Z",
        }),
      ]),
      [
        // Stale: the poll has already returned this write's result, so the
        // overlay has nothing left to say and must not pin an older title.
        {
          slug: slug("alpamayo"),
          display: { title: "Alpamayo Pipeline" },
          stamp: "2026-07-26T00:00:00.000Z",
          created: false,
        },
      ],
    );
    expect(view.projects[0]!.display.updatedAt).toBe("2026-07-26T00:00:00.000Z");
    expect(view.projects[0]!.sections).toHaveLength(1);
  });

  it("renders a just-created category no machine has reported yet", () => {
    // "Just created" is now literal — the overlay expires — so the clock is
    // passed rather than left ambient. Without it this test asserted a
    // just-created project while the stamp sat in whatever relation to the
    // wall clock the calendar happened to put it.
    const stamp = "2026-07-26T00:00:00.000Z";
    const view = applyPendingProjectDisplays(
      viewOf([]),
      [{ slug: slug("new-thing"), display: { title: "New Thing" }, stamp, created: true }],
      Date.parse(stamp) + 1_000,
    );
    expect(view.projects.map((project) => project.display.title)).toEqual(["New Thing"]);
    expect(view.projects[0]!.sections).toEqual([]);
  });

  it("stops rendering a created category no machine ever accepted", () => {
    // The ghost. A create that every machine refused (or that reached none of
    // them) has no record for the fold to catch up to, so before the grace it
    // rendered for the rest of the session: a project you could open, name and
    // file threads into, none of which went anywhere.
    const stamp = "2026-07-26T00:00:00.000Z";
    const pending = [
      { slug: slug("never-landed"), display: { title: "Ghost" }, stamp, created: true },
    ];
    const stampMs = Date.parse(stamp);

    expect(
      applyPendingProjectDisplays(
        viewOf([]),
        pending,
        stampMs + PENDING_PROJECT_CREATE_GRACE_MS - 1,
      ).projects,
    ).toHaveLength(1);
    expect(
      applyPendingProjectDisplays(viewOf([]), pending, stampMs + PENDING_PROJECT_CREATE_GRACE_MS)
        .projects,
    ).toEqual([]);
  });

  it("keeps showing a create that a machine did accept, however old", () => {
    // Past the grace the overlay is gone, but the machine's own record is what
    // renders now — expiring the overlay must not expire the project.
    const view = applyPendingProjectDisplays(
      viewOf([record({ slug: "landed", title: "Landed" })]),
      [
        {
          slug: slug("landed"),
          display: { title: "Landed" },
          stamp: "2026-07-26T00:00:00.000Z",
          created: true,
        },
      ],
      Date.parse("2026-08-01T00:00:00.000Z"),
    );

    expect(view.projects.map((project) => project.slug)).toEqual(["landed"]);
  });

  it("never expires a rename, because that project exists", () => {
    // The asymmetry is deliberate: reverting an edit the operator made, on a
    // project that is really there, is worse than showing it a while longer.
    const view = applyPendingProjectDisplays(
      viewOf([
        record({ slug: "alpamayo", title: "Alpamayo", updatedAt: "2026-07-25T00:00:00.000Z" }),
      ]),
      [
        {
          slug: slug("alpamayo"),
          display: { title: "Alpamayo Pipeline" },
          stamp: "2026-07-26T00:00:00.000Z",
          created: false,
        },
      ],
      Date.parse("2026-09-01T00:00:00.000Z"),
    );

    expect(view.projects[0]!.display.title).toBe("Alpamayo Pipeline");
  });

  it("does not invent a category for a write that was not a create", () => {
    const view = applyPendingProjectDisplays(viewOf([]), [
      {
        slug: slug("renamed-elsewhere"),
        display: { title: "Renamed" },
        stamp: "2026-07-26T00:00:00.000Z",
        created: false,
      },
    ]);
    expect(view.projects).toEqual([]);
  });

  it("keeps only the newest pending write per category", () => {
    const view = applyPendingProjectDisplays(viewOf([record({ slug: "alpamayo" })]), [
      {
        slug: slug("alpamayo"),
        display: { title: "Second" },
        stamp: "2026-07-27T00:00:00.000Z",
        created: false,
      },
      {
        slug: slug("alpamayo"),
        display: { title: "First" },
        stamp: "2026-07-26T00:00:00.000Z",
        created: false,
      },
    ]);
    expect(view.projects[0]!.display.title).toBe("Second");
  });

  it("carries an optimistic archive through to the derived flag", () => {
    const view = applyPendingProjectDisplays(viewOf([record({ slug: "alpamayo" })]), [
      {
        slug: slug("alpamayo"),
        display: { archivedAt: "2026-07-26T00:00:00.000Z" },
        stamp: "2026-07-26T00:00:00.000Z",
        created: false,
      },
    ]);
    expect(view.projects[0]!.archived).toBe(true);
  });
});
