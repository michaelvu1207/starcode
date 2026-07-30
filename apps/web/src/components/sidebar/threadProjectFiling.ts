/**
 * Fork-owned: moving one thread between projects, from the row it is on.
 *
 * The triage panel above the Chats group answers "here are eleven loose threads,
 * file them". This answers the other half of the same question — "this one is in
 * the wrong place" — and it is the half you hit while reading, not while
 * tidying, which is why it belongs on the row rather than behind a panel.
 *
 * The whole of the interesting part is here, in two pure functions, because the
 * write is not one call. Membership is `derived ∪ adds \ excludes`, so what
 * "move this thread" costs depends on how it got where it is:
 *
 * - **Into a project** — one `assign`. An explicit add outranks a derived
 *   binding anywhere else (`resolveProjectMembership`), so nothing has to be
 *   retracted first, and the registry already drops the thread from every other
 *   category on the machine as part of assigning.
 * - **Back to Chats** — `unfile` clears every explicit opinion this machine
 *   holds, which is enough only when the thread was explicitly filed. If its
 *   *folder* is bound to a category, derivation puts it straight back, so the
 *   plan carries a second request that excludes it from exactly that category.
 *   Excluding without unfiling first would leave a stale add on some third
 *   category; unfiling without excluding would look like the click did nothing.
 *
 * Both requests go to the machine that owns the thread and nowhere else — a
 * thread id means nothing anywhere else — and they are ordered, so the caller
 * must send them in sequence rather than in parallel.
 */
import type {
  ProjectCatalogFileThreadRequest,
  ProjectCategorySlug,
  ThreadId,
} from "@starcode/contracts";

import {
  projectThreadKey,
  resolveDerivedProjectSlug,
  resolveProjectMembership,
  type ProjectCategoryView,
  type ProjectMembershipThread,
} from "../projects/ProjectCatalog.model";

/** Where a thread is filed now, and what derivation would say without overrides. */
export interface ThreadFilingState {
  /** The category the thread is in today, after adds and excludes. */
  readonly currentSlug: ProjectCategorySlug | null;
  /** What the thread's folder alone claims. Null when nothing is bound to it. */
  readonly derivedSlug: ProjectCategorySlug | null;
}

/**
 * Membership is resolved by the one implementation of it, over a single-thread
 * list. Deliberately not a cheaper hand-rolled lookup: the rules that decide
 * which category claims a thread are exactly the rules a second copy would
 * eventually disagree with.
 */
export function resolveThreadFilingState(input: {
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  readonly thread: ProjectMembershipThread;
}): ThreadFilingState {
  const membership = resolveProjectMembership({
    projects: input.projects,
    threads: [input.thread],
  });
  return {
    currentSlug: membership.slugByThreadKey.get(projectThreadKey(input.thread)) ?? null,
    derivedSlug: resolveDerivedProjectSlug({ projects: input.projects, thread: input.thread }),
  };
}

/**
 * The requests that move a thread to `target`, in the order they must be sent.
 *
 * Empty when the thread is already there — a click that would write nothing
 * should write nothing, so the caller can treat an empty plan as "no-op" rather
 * than round-tripping to discover it.
 */
export function planThreadFiling(input: {
  readonly threadId: ThreadId;
  readonly state: ThreadFilingState;
  /** `null` means "out of every project", i.e. back down to Chats. */
  readonly target: ProjectCategorySlug | null;
}): ReadonlyArray<ProjectCatalogFileThreadRequest> {
  const { currentSlug, derivedSlug } = input.state;
  if (input.target !== null) {
    if (currentSlug === input.target) return [];
    return [{ mode: "assign", threadId: input.threadId, slug: input.target }];
  }
  if (currentSlug === null) return [];
  const plan: Array<ProjectCatalogFileThreadRequest> = [
    { mode: "unfile", threadId: input.threadId, slug: null },
  ];
  // Only a *bound folder* survives an unfile. An explicitly filed thread needs
  // no exclusion, and adding one would leave a permanent "not this one" on a
  // category the thread was never derived into.
  if (derivedSlug !== null) {
    plan.push({ mode: "exclude", threadId: input.threadId, slug: derivedSlug });
  }
  return plan;
}
