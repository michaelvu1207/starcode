/**
 * The rule that says which project a feature belongs to.
 *
 * It lives in contracts for the same reason `resolveLocalProjectMembership`
 * does: the server's `project_get` and the client's per-project sky both need
 * the answer, and a rule stated twice is a rule that eventually says two
 * things. These tests pin the two clauses and the order between them — a filed
 * feature stays filed however its thread is moved, and an unfiled one follows
 * its thread — plus the case that made the field necessary at all, a planned
 * feature with no thread to inherit from.
 */
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "./baseSchemas.ts";
import { featureMapEntryInProject } from "./featureMap.ts";
import { ProjectCategorySlug } from "./projectCategorySlug.ts";

const slug = (value: string) => ProjectCategorySlug.make(value);
const thread = (value: string) => ThreadId.make(value);

/** "This project claims exactly thread-1." */
const claims = (...ids: ReadonlyArray<string>) => {
  const set = new Set(ids);
  return (threadId: ThreadId) => set.has(threadId);
};

describe("featureMapEntryInProject", () => {
  it("puts a filed feature in the project it names", () => {
    expect(
      featureMapEntryInProject({ slug: slug("atlas"), threadId: null }, slug("atlas"), claims()),
    ).toBe(true);
  });

  it("keeps a filed feature out of every other project", () => {
    expect(
      featureMapEntryInProject({ slug: slug("atlas"), threadId: null }, slug("beacon"), claims()),
    ).toBe(false);
  });

  it("reaches a planned feature, which has no thread to be found by", () => {
    // The whole reason the field exists: before it, a planned entry could not
    // be attributed to a project by any rule keyed on threads.
    expect(
      featureMapEntryInProject({ slug: slug("atlas"), threadId: null }, slug("atlas"), claims()),
    ).toBe(true);
  });

  it("lets the slug outrank the thread's own project", () => {
    // The feature is filed under atlas; its thread has been refiled to beacon.
    // Refiling a thread is not a statement about the feature.
    const entry = { slug: slug("atlas"), threadId: thread("thread-1") };
    expect(featureMapEntryInProject(entry, slug("atlas"), claims())).toBe(true);
    expect(featureMapEntryInProject(entry, slug("beacon"), claims("thread-1"))).toBe(false);
  });

  it("falls back to the thread's project for an unfiled feature", () => {
    // Every entry written before the field existed takes this path, which is
    // what makes filing optional rather than a migration.
    expect(
      featureMapEntryInProject(
        { slug: null, threadId: thread("thread-1") },
        slug("atlas"),
        claims("thread-1"),
      ),
    ).toBe(true);
    expect(
      featureMapEntryInProject(
        { slug: null, threadId: thread("thread-2") },
        slug("atlas"),
        claims("thread-1"),
      ),
    ).toBe(false);
  });

  it("puts an unfiled feature with no thread in no project at all", () => {
    // Nothing has said where it goes, so the honest answer is the fleet sky and
    // nowhere else — not "everywhere", which is what the unfiltered map did.
    expect(
      featureMapEntryInProject({ slug: null, threadId: null }, slug("atlas"), claims("thread-1")),
    ).toBe(false);
  });
});
