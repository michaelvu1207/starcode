/**
 * The single-machine membership rule.
 *
 * It lives in contracts because two callers need the same answer — the MCP
 * tools on the server and, in its cross-machine form, the web client's fold —
 * and a rule stated twice is a rule that eventually says two things. These
 * tests pin the parts that are easy to get subtly wrong: which of two claims on
 * the same thread wins, and what an exclusion does to a thread nothing else
 * asked for.
 */
import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { resolveLocalProjectMembership, type ProjectCategoryRecord } from "./projectCatalog.ts";
import { ProjectCategorySlug } from "./projectCategorySlug.ts";

const project = (value: string) => ProjectId.make(value);
const thread = (value: string) => ThreadId.make(value);

const category = (input: {
  readonly slug: string;
  readonly bindings?: ReadonlyArray<string>;
  readonly threadIds?: ReadonlyArray<string>;
  readonly excludedThreadIds?: ReadonlyArray<string>;
}): ProjectCategoryRecord => ({
  slug: ProjectCategorySlug.make(input.slug),
  createdAt: "2026-07-01T00:00:00.000Z",
  display: {
    title: input.slug,
    summary: "",
    accent: "",
    glyph: "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
  local: {
    bindings: (input.bindings ?? []).map((id) => ({
      projectId: project(id),
      boundAt: "2026-07-01T00:00:00.000Z",
    })),
    threadIds: (input.threadIds ?? []).map(thread),
    excludedThreadIds: (input.excludedThreadIds ?? []).map(thread),
    masterThreadId: "",
    masterDefaults: { runtimeMode: "approval-required", interactionMode: "plan" },
    defaults: {},
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
});

const threads = [
  { id: thread("t-hub"), projectId: project("p-hub") },
  { id: thread("t-scratch"), projectId: project("p-scratch") },
];

const slugsOf = (result: ReadonlyMap<ProjectCategorySlug, ReadonlyArray<ThreadId>>) =>
  [...result.entries()]
    .map(([slug, ids]) => [slug, [...ids].toSorted()] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));

describe("resolveLocalProjectMembership", () => {
  it("files a thread by the folder it is in, before anyone files anything by hand", () => {
    const result = resolveLocalProjectMembership({
      categories: [category({ slug: "hub", bindings: ["p-hub"] })],
      threads,
    });
    expect(slugsOf(result)).toEqual([["hub", ["t-hub"]]]);
  });

  it("lets an explicit add beat the folder the thread actually sits in", () => {
    const result = resolveLocalProjectMembership({
      categories: [
        category({ slug: "hub", bindings: ["p-hub"] }),
        category({ slug: "research", threadIds: ["t-hub"] }),
      ],
      threads,
    });
    expect(slugsOf(result)).toEqual([["research", ["t-hub"]]]);
  });

  it("takes a derived thread out when a category excludes it, and files it nowhere else", () => {
    const result = resolveLocalProjectMembership({
      categories: [category({ slug: "hub", bindings: ["p-hub"], excludedThreadIds: ["t-hub"] })],
      threads,
    });
    expect(slugsOf(result)).toEqual([]);
  });

  it("keeps a thread that was both added and excluded, because the add is the later word", () => {
    // Exclusion only answers the derived question. A thread explicitly filed
    // into a category is there because someone said so, and a stale exclusion
    // from before that must not quietly undo it.
    const result = resolveLocalProjectMembership({
      categories: [
        category({
          slug: "hub",
          bindings: ["p-hub"],
          threadIds: ["t-hub"],
          excludedThreadIds: ["t-hub"],
        }),
      ],
      threads,
    });
    expect(slugsOf(result)).toEqual([["hub", ["t-hub"]]]);
  });

  it("settles two categories binding one folder on the smaller slug, not on file order", () => {
    const forwards = resolveLocalProjectMembership({
      categories: [
        category({ slug: "alpha", bindings: ["p-hub"] }),
        category({ slug: "beta", bindings: ["p-hub"] }),
      ],
      threads,
    });
    const backwards = resolveLocalProjectMembership({
      categories: [
        category({ slug: "beta", bindings: ["p-hub"] }),
        category({ slug: "alpha", bindings: ["p-hub"] }),
      ],
      threads,
    });
    expect(slugsOf(forwards)).toEqual([["alpha", ["t-hub"]]]);
    expect(slugsOf(backwards)).toEqual(slugsOf(forwards));
  });

  it("gives a category with no bindings the threads filed into it and nothing more", () => {
    // The "not folder-related" case: a project whose work lives in scratch
    // directories is a legal project, not an empty one.
    const result = resolveLocalProjectMembership({
      categories: [category({ slug: "alpamayo", threadIds: ["t-scratch"] })],
      threads,
    });
    expect(slugsOf(result)).toEqual([["alpamayo", ["t-scratch"]]]);
  });
});
