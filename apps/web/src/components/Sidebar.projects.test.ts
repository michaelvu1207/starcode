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
  SIDEBAR_CHATS_GROUP_TITLE,
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
    icon: "",
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
}) => {
  const threads = input.active ?? [];
  return buildSidebarProjectGroups({
    threads,
    projects: input.projects,
    membership: membershipFor(input.projects, threads),
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
    expect(groups[0]?.rows.map((row) => row.id)).toEqual([alpha.id]);
    expect(groups[1]?.rows.map((row) => row.id)).toEqual([beta.id]);
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
    expect(groups[0]?.rows.map((row) => row.environmentId)).toEqual([LOCAL, LAPTOP]);
  });

  it("carries the inbox's order into each group", () => {
    const first = makeThread("t-first", LOCAL);
    const second = makeThread("t-second", LOCAL);
    const third = makeThread("t-third", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [third.id, first.id, second.id] } }],
      }),
    ];

    // The catalog lists them in its own order; the group must follow the
    // inbox's.
    const { groups } = build({ projects, active: [first, second, third] });

    expect(groups[0]?.rows).toEqual([first, second, third]);
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

describe("the Chats section", () => {
  it("collects threads no project claims, out of the project list entirely", () => {
    const filed = makeThread("t-filed", LOCAL);
    const loose = makeThread("t-loose", LOCAL);
    const projects = [
      project({
        slug: "zephyr",
        title: "Zephyr",
        sections: [{ environmentId: LOCAL, local: { threadIds: [filed.id] } }],
      }),
    ];

    const { groups, chatsGroup } = build({ projects, active: [filed, loose] });

    // The point of the split: `groups` is projects and only projects, so a
    // caller rendering it top to bottom cannot put loose threads among them.
    expect(groups.map((group) => group.key)).toEqual(["zephyr"]);
    expect(chatsGroup?.key).toBe(SIDEBAR_UNFILED_GROUP_KEY);
    expect(chatsGroup?.title).toBe(SIDEBAR_CHATS_GROUP_TITLE);
    expect(chatsGroup?.slug).toBeNull();
    expect(chatsGroup?.rows.map((row) => row.id)).toEqual([loose.id]);
  });

  it("is null when every thread is filed, rather than an empty header", () => {
    const filed = makeThread("t-filed", LOCAL);
    const projects = [
      project({
        slug: "atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [filed.id] } }],
      }),
    ];

    const { groups, chatsGroup } = build({ projects, active: [filed] });

    expect(groups.map((group) => group.key)).toEqual(["atlas"]);
    expect(chatsGroup).toBeNull();
  });

  it("takes a thread excluded from its derived project", () => {
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

    const { groups, chatsGroup } = build({ projects, active: [bound] });

    expect(groups[0]?.rows).toEqual([]);
    expect(chatsGroup?.rows.map((row) => row.id)).toEqual([bound.id]);
  });

  it("keeps the inbox's order, the same as a project group", () => {
    const first = makeThread("t-first", LOCAL);
    const second = makeThread("t-second", LOCAL);
    const third = makeThread("t-third", LOCAL);

    const { chatsGroup } = build({ projects: [], active: [first, second, third] });

    expect(chatsGroup?.rows).toEqual([first, second, third]);
  });
});

describe("no inbox semantics", () => {
  // Michael's ask: the projects view is projects, not a second inbox. The
  // partition used to roll "waiting on you" up onto every group header, which
  // is the signal that made it one. Nothing here may reintroduce it.
  it("puts no attention rollup on a project group", () => {
    const approval = makeThread("t-approval", LOCAL, { hasPendingApprovals: true });
    const asking = makeThread("t-asking", LOCAL, { hasPendingUserInput: true });
    const projects = [
      project({
        slug: "atlas",
        sections: [{ environmentId: LOCAL, local: { threadIds: [approval.id, asking.id] } }],
      }),
    ];

    const { groups } = build({ projects, active: [approval, asking] });

    expect(groups[0]?.rows).toHaveLength(2);
    expect(groups[0]).not.toHaveProperty("attentionCount");
  });

  it("puts none on the Chats group either", () => {
    const approval = makeThread("t-approval", LOCAL, { hasPendingApprovals: true });

    const { chatsGroup } = build({ projects: [], active: [approval] });

    expect(chatsGroup?.rows).toHaveLength(1);
    expect(chatsGroup).not.toHaveProperty("attentionCount");
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
    expect(archivedGroups[0]?.rows.map((row) => row.id)).toEqual([shelved.id]);
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
