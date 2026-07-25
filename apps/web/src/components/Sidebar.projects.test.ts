import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectCategoryLocal,
  type ProjectCategorySlug,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveProjectMembership,
  type ProjectCategoryView,
} from "./projects/ProjectCatalog.model";
import {
  buildSidebarProjectGroups,
  countSidebarProjectRows,
  resolveSidebarProjectGroupExpanded,
  sidebarProjectGroupExpansionKey,
  SIDEBAR_UNFILED_GROUP_KEY,
} from "./Sidebar.projects";
import { supportsSidebarRangeSelect } from "./Sidebar.connections";

const LOCAL = EnvironmentId.make("env-local");
const LAPTOP = EnvironmentId.make("env-laptop");

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
  readonly archived?: boolean;
  readonly sections?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly local?: Partial<ProjectCategoryLocal>;
  }>;
}): ProjectCategoryView => ({
  slug: slug(input.slug),
  createdAt: "2026-07-01T00:00:00.000Z",
  display: {
    title: input.title ?? input.slug,
    summary: "",
    accent: "",
    glyph: "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: input.archived === true ? "2026-07-20T00:00:00.000Z" : null,
    updatedAt: "2026-07-25T00:00:00.000Z",
  },
  archived: input.archived === true,
  sections: (input.sections ?? []).map((section) => ({
    environmentId: section.environmentId,
    label: section.environmentId,
    isLocal: section.environmentId === LOCAL,
    local: local(section.local),
  })),
  staleEnvironmentIds: [],
});

function makeThread(
  id: string,
  environmentId: EnvironmentId,
  overrides?: Partial<EnvironmentThreadShell>,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

/** Membership resolved the way the app resolves it, never hand-written. */
const membershipFor = (
  projects: ReadonlyArray<ProjectCategoryView>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) =>
  resolveProjectMembership({
    projects,
    threads: threads.map((thread) => ({
      environmentId: thread.environmentId,
      id: thread.id,
      projectId: thread.projectId,
    })),
  });

const build = (input: {
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  readonly active?: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozed?: ReadonlyArray<EnvironmentThreadShell>;
  readonly settled?: ReadonlyArray<EnvironmentThreadShell>;
}) => {
  const active = input.active ?? [];
  const snoozed = input.snoozed ?? [];
  const settled = input.settled ?? [];
  return buildSidebarProjectGroups({
    activeThreads: active,
    snoozedThreads: snoozed,
    settledThreads: settled,
    projects: input.projects,
    membership: membershipFor(input.projects, [...active, ...snoozed, ...settled]),
  });
};

describe("buildSidebarProjectGroups", () => {
  it("groups threads under the project that claims them, by explicit file", () => {
    const alpha = makeThread("t-alpha", LOCAL);
    const beta = makeThread("t-beta", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        title: "Atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [alpha.id] } }],
      }),
      project({
        slug: "borealis",
        title: "Borealis",
        sections: [{ environmentId: LOCAL, local: { threadIds: [beta.id] } }],
      }),
    ];

    const { groups } = build({ projects, active: [alpha, beta] });

    expect(groups.map((group) => group.title)).toEqual(["Atlas", "Borealis"]);
    expect(groups[0]?.rows.map((row) => row.thread.id)).toEqual([alpha.id]);
    expect(groups[1]?.rows.map((row) => row.thread.id)).toEqual([beta.id]);
  });

  it("puts one project's threads from different machines in the same group", () => {
    const here = makeThread("t-here", LOCAL);
    const there = makeThread("t-there", LAPTOP);
    const projects = [
      project({
        slug: "atlas",
        sections: [
          { environmentId: LOCAL, local: { threadIds: [here.id] } },
          { environmentId: LAPTOP, local: { threadIds: [there.id] } },
        ],
      }),
    ];

    const { groups } = build({ projects, active: [here, there] });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows.map((row) => row.thread.environmentId)).toEqual([LOCAL, LAPTOP]);
  });

  it("carries the inbox's section order into each group", () => {
    const working = makeThread("t-working", LOCAL);
    const napping = makeThread("t-napping", LOCAL);
    const done = makeThread("t-done", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        sections: [
          { environmentId: LOCAL, local: { threadIds: [working.id, napping.id, done.id] } },
        ],
      }),
    ];

    const { groups } = build({
      projects,
      active: [working],
      snoozed: [napping],
      settled: [done],
    });

    expect(groups[0]?.rows).toEqual([
      { thread: working, section: "active" },
      { thread: napping, section: "snoozed" },
      { thread: done, section: "settled" },
    ]);
  });

  it("keeps a project with no threads rather than dropping it", () => {
    const { groups } = build({ projects: [project({ slug: "atlas" })] });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toEqual([]);
  });

  it("orders groups by title and never by attention", () => {
    const loud = makeThread("t-loud", LOCAL, { hasPendingApprovals: true });
    const quiet = makeThread("t-quiet", LOCAL);
    const projects = [
      project({
        slug: "zephyr",
        title: "Zephyr",
        sections: [{ environmentId: LOCAL, local: { threadIds: [loud.id] } }],
      }),
      project({
        slug: "atlas",
        title: "Atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [quiet.id] } }],
      }),
    ];

    const { groups } = build({ projects, active: [loud, quiet] });

    expect(groups.map((group) => group.title)).toEqual(["Atlas", "Zephyr"]);
  });
});

describe("unfiled", () => {
  it("collects threads no project claims, and sorts the group last", () => {
    const filed = makeThread("t-filed", LOCAL);
    const loose = makeThread("t-loose", LOCAL);
    const projects = [
      project({
        slug: "zephyr",
        title: "Zephyr",
        sections: [{ environmentId: LOCAL, local: { threadIds: [filed.id] } }],
      }),
    ];

    const { groups } = build({ projects, active: [filed, loose] });

    expect(groups.map((group) => group.key)).toEqual(["zephyr", SIDEBAR_UNFILED_GROUP_KEY]);
    const unfiled = groups[1];
    expect(unfiled?.slug).toBeNull();
    expect(unfiled?.rows.map((row) => row.thread.id)).toEqual([loose.id]);
  });

  it("omits the group entirely when every thread is filed", () => {
    const filed = makeThread("t-filed", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [filed.id] } }],
      }),
    ];

    const { groups } = build({ projects, active: [filed] });

    expect(groups.map((group) => group.key)).toEqual(["atlas"]);
  });

  it("counts a thread excluded from its derived project as unfiled", () => {
    const bound = makeThread("t-bound", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        sections: [
          {
            environmentId: LOCAL,
            local: {
              bindings: [{ projectId: bound.projectId, boundAt: "2026-07-20T00:00:00.000Z" }],
              excludedThreadIds: [bound.id],
            },
          },
        ],
      }),
    ];

    const { groups } = build({ projects, active: [bound] });

    expect(groups[0]?.rows).toEqual([]);
    expect(groups[1]?.key).toBe(SIDEBAR_UNFILED_GROUP_KEY);
    expect(groups[1]?.rows.map((row) => row.thread.id)).toEqual([bound.id]);
  });
});

describe("attention rollup", () => {
  it("counts threads whose agent is waiting on a human", () => {
    const approval = makeThread("t-approval", LOCAL, { hasPendingApprovals: true });
    const asking = makeThread("t-asking", LOCAL, { hasPendingUserInput: true });
    const idle = makeThread("t-idle", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        sections: [
          { environmentId: LOCAL, local: { threadIds: [approval.id, asking.id, idle.id] } },
        ],
      }),
    ];

    const { groups } = build({ projects, active: [approval, asking, idle] });

    expect(groups[0]?.attentionCount).toBe(2);
  });

  it("ignores settled threads — a settled thread is waiting on nobody", () => {
    const parked = makeThread("t-parked", LOCAL, { hasPendingApprovals: true });
    const projects = [
      project({
        slug: "atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [parked.id] } }],
      }),
    ];

    const { groups } = build({ projects, settled: [parked] });

    expect(groups[0]?.rows).toHaveLength(1);
    expect(groups[0]?.attentionCount).toBe(0);
  });

  it("counts snoozed threads — snoozed work is coming back", () => {
    const napping = makeThread("t-napping", LOCAL, { hasPendingApprovals: true });
    const projects = [
      project({
        slug: "atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [napping.id] } }],
      }),
    ];

    const { groups } = build({ projects, snoozed: [napping] });

    expect(groups[0]?.attentionCount).toBe(1);
  });
});

describe("archived projects", () => {
  it("keeps them out of the main list and hands them to the caller separately", () => {
    const shelved = makeThread("t-shelved", LOCAL);
    const current = makeThread("t-current", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        title: "Atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [current.id] } }],
      }),
      project({
        slug: "old-thing",
        title: "Old thing",
        archived: true,
        sections: [{ environmentId: LOCAL, local: { threadIds: [shelved.id] } }],
      }),
    ];

    const { groups, archivedGroups } = build({ projects, active: [current, shelved] });

    expect(groups.map((group) => group.key)).toEqual(["atlas"]);
    expect(archivedGroups.map((group) => group.key)).toEqual(["old-thing"]);
    // The archived project still owns its thread: it must not leak into
    // "unfiled", which would make archiving look like a filing decision.
    expect(archivedGroups[0]?.rows.map((row) => row.thread.id)).toEqual([shelved.id]);
  });

  it("reports how many threads a collapsed disclosure is hiding", () => {
    const one = makeThread("t-one", LOCAL);
    const two = makeThread("t-two", LAPTOP);
    const projects = [
      project({
        slug: "old-thing",
        archived: true,
        sections: [
          { environmentId: LOCAL, local: { threadIds: [one.id] } },
          { environmentId: LAPTOP, local: { threadIds: [two.id] } },
        ],
      }),
    ];

    const { archivedGroups } = build({ projects, active: [one, two] });

    expect(countSidebarProjectRows(archivedGroups)).toBe(2);
  });
});

describe("collapse state", () => {
  it("namespaces its keys away from the connections view's", () => {
    expect(sidebarProjectGroupExpansionKey("atlas")).toBe("sidebar-project-group:atlas");
  });

  it("defaults to expanded and honours an explicit collapse", () => {
    expect(resolveSidebarProjectGroupExpanded({}, "atlas")).toBe(true);
    expect(
      resolveSidebarProjectGroupExpanded({ "sidebar-project-group:atlas": false }, "atlas"),
    ).toBe(false);
  });
});

describe("range select", () => {
  it("stays an inbox affordance — a project group's order is not the flat one", () => {
    expect(supportsSidebarRangeSelect("projects")).toBe(false);
  });
});
