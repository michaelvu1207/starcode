import type {
  EnvironmentId,
  ProjectCategoryLocal,
  ProjectCategoryRecord,
  ProjectCategorySlug,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectCatalogView,
  type ProjectCatalogEnvironmentInput,
} from "../projects/ProjectCatalog.model";
import { planThreadFiling, resolveThreadFilingState } from "./threadProjectFiling";

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
  readonly archivedAt?: string | null;
  readonly local?: Partial<ProjectCategoryLocal>;
}): ProjectCategoryRecord => ({
  slug: slug(input.slug),
  createdAt: "2026-07-01T00:00:00.000Z",
  display: {
    title: input.slug,
    summary: "",
    accent: "",
    glyph: "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: input.archivedAt ?? null,
    updatedAt: "2026-07-25T00:00:00.000Z",
  },
  local: local(input.local),
});

const machine = (
  categories: ReadonlyArray<ProjectCategoryRecord>,
): ProjectCatalogEnvironmentInput =>
  ({
    environmentId: env("mac"),
    label: "mac",
    isLocal: true,
    snapshot: { categories, computedAt: "2026-07-25T00:00:00.000Z" },
    supported: true,
    pending: false,
  }) satisfies ProjectCatalogEnvironmentInput;

const projectsOf = (categories: ReadonlyArray<ProjectCategoryRecord>) =>
  buildProjectCatalogView([machine(categories)]).projects;

const t1 = { environmentId: env("mac"), id: thread("t1"), projectId: project("p1") };
const boundToP1 = { bindings: [{ projectId: project("p1"), boundAt: "2026-07-01T00:00:00.000Z" }] };

describe("resolveThreadFilingState", () => {
  it("reports an unfiled thread as in nothing and derived from nothing", () => {
    const state = resolveThreadFilingState({
      projects: projectsOf([record({ slug: "alpamayo" })]),
      thread: t1,
    });

    expect(state).toEqual({ currentSlug: null, derivedSlug: null });
  });

  it("separates where a derived thread is from what put it there", () => {
    const state = resolveThreadFilingState({
      projects: projectsOf([record({ slug: "alpamayo", local: boundToP1 })]),
      thread: t1,
    });

    expect(state).toEqual({ currentSlug: "alpamayo", derivedSlug: "alpamayo" });
  });

  it("keeps the derived answer visible when an explicit add outranks it", () => {
    const state = resolveThreadFilingState({
      projects: projectsOf([
        record({ slug: "alpamayo", local: boundToP1 }),
        record({ slug: "starcode", local: { threadIds: [thread("t1")] } }),
      ]),
      thread: t1,
    });

    // The thread reads as filed into starcode, but alpamayo is still the
    // category that would reclaim it — which is the whole reason this is two
    // fields and not one.
    expect(state).toEqual({ currentSlug: "starcode", derivedSlug: "alpamayo" });
  });

  it("reports an excluded derived thread as filed nowhere, and still derived", () => {
    const state = resolveThreadFilingState({
      projects: projectsOf([
        record({ slug: "alpamayo", local: { ...boundToP1, excludedThreadIds: [thread("t1")] } }),
      ]),
      thread: t1,
    });

    expect(state).toEqual({ currentSlug: null, derivedSlug: "alpamayo" });
  });
});

describe("planThreadFiling", () => {
  it("files an unfiled thread with a single assign", () => {
    expect(
      planThreadFiling({
        threadId: thread("t1"),
        state: { currentSlug: null, derivedSlug: null },
        target: slug("starcode"),
      }),
    ).toEqual([{ mode: "assign", threadId: "t1", slug: "starcode" }]);
  });

  it("moves a derived thread to another project without retracting the binding", () => {
    // An explicit add outranks a derived binding, so one request is the whole
    // move. A second "exclude alpamayo" here would be a permanent mark on a
    // category the user only walked past.
    expect(
      planThreadFiling({
        threadId: thread("t1"),
        state: { currentSlug: slug("alpamayo"), derivedSlug: slug("alpamayo") },
        target: slug("starcode"),
      }),
    ).toEqual([{ mode: "assign", threadId: "t1", slug: "starcode" }]);
  });

  it("writes nothing when the thread is already in the target project", () => {
    expect(
      planThreadFiling({
        threadId: thread("t1"),
        state: { currentSlug: slug("starcode"), derivedSlug: null },
        target: slug("starcode"),
      }),
    ).toEqual([]);
  });

  it("writes nothing when an unfiled thread is sent back to Chats", () => {
    expect(
      planThreadFiling({
        threadId: thread("t1"),
        state: { currentSlug: null, derivedSlug: slug("alpamayo") },
        target: null,
      }),
    ).toEqual([]);
  });

  it("unfiles an explicitly filed thread and stops there", () => {
    expect(
      planThreadFiling({
        threadId: thread("t1"),
        state: { currentSlug: slug("starcode"), derivedSlug: null },
        target: null,
      }),
    ).toEqual([{ mode: "unfile", threadId: "t1", slug: null }]);
  });

  it("excludes the binding that would reclaim a derived thread, after unfiling", () => {
    expect(
      planThreadFiling({
        threadId: thread("t1"),
        state: { currentSlug: slug("alpamayo"), derivedSlug: slug("alpamayo") },
        target: null,
      }),
    ).toEqual([
      { mode: "unfile", threadId: "t1", slug: null },
      { mode: "exclude", threadId: "t1", slug: "alpamayo" },
    ]);
  });

  it("excludes the derived category, not the one the thread was filed into", () => {
    // Filed into starcode by hand, but its folder belongs to alpamayo. Unfiling
    // alone drops it into alpamayo instead of Chats, which reads as the click
    // having moved it somewhere the user never asked for.
    expect(
      planThreadFiling({
        threadId: thread("t1"),
        state: { currentSlug: slug("starcode"), derivedSlug: slug("alpamayo") },
        target: null,
      }),
    ).toEqual([
      { mode: "unfile", threadId: "t1", slug: null },
      { mode: "exclude", threadId: "t1", slug: "alpamayo" },
    ]);
  });
});
