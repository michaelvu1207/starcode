/**
 * The sidebar v2 projects view: the same threads the inbox shows, regrouped
 * under the project they were filed into.
 *
 * Like the connections view, this is a fold over the inbox partition rather
 * than its own pass over the raw shells — the partition is where the
 * capability-skew rule lives, and a second classifier would drift from the
 * inbox the first time either changed. Unlike the connections view, the key it
 * folds on is not a property of the thread: a machine is stamped on the shell,
 * a project is a decision recorded in a catalog four machines each hold a piece
 * of. So membership arrives already resolved by `ProjectCatalog.model.ts` and
 * nothing here re-derives it. There is exactly one implementation of "which
 * project does this thread belong to" and this is not it.
 *
 * The consequence worth naming: a project group mixes machines. That is the
 * whole point of the view — the project is the category, the machine is a
 * detail the row already carries — and it is the one structural difference from
 * the connections view, where a group is a machine and can never mix.
 *
 * Order inside a group is the inbox's order, preserved: active first (ranked by
 * attention, or by creation when the user opted out), then the snooze shelf by
 * soonest wake, then the settled tail by when the work ended. Order OF the
 * groups is by title, and deliberately NOT by attention the way the /projects
 * index sorts its cards. The index is a dashboard you open to decide what to
 * work on, so ranking is its job; the sidebar is a map you navigate all day,
 * and a map whose landmarks reshuffle when an agent asks a question is a map
 * you cannot learn.
 *
 * Nothing here rolls attention up to a group. An earlier revision put a
 * "3 waiting on you" badge on every header, which quietly made this view a
 * second inbox — a list of projects ranked by how much they were nagging.
 * Projects are the categories you organised your work into; the inbox is the
 * view that triages, and it is one menu away. If you want to know what is
 * waiting, the rows already say so, each in its own group.
 *
 * Threads no project claims do not become a group among the projects either.
 * They come back separately as `chatsGroup`, for the caller to render at the
 * very bottom under "Chats" — below the archived disclosure, below everything.
 * A loose thread is not a category, and sorting one into the middle of the list
 * under "U" for Unfiled made it look like one.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectCategorySlug } from "@t3tools/contracts";

import {
  projectThreadKey,
  type ProjectCategoryView,
  type ProjectMembership,
} from "./projects/ProjectCatalog.model";
// The row shape and the paging rule are the connections view's, reused rather
// than restated. The rule that the thread open in the chat pane is never the
// one hidden behind "show more" is a correctness rule, not a layout choice, and
// two copies of it would eventually disagree.
import {
  limitSidebarConnectionRows,
  type SidebarConnectionRow,
  type SidebarConnectionSection,
} from "./Sidebar.connections";

export const SIDEBAR_PROJECT_ROWS_INITIAL_COUNT = 25;
export const SIDEBAR_PROJECT_ROWS_PAGE_COUNT = 25;

export type SidebarProjectSection = SidebarConnectionSection;
export type SidebarProjectRow = SidebarConnectionRow;

export { limitSidebarConnectionRows as limitSidebarProjectRows };

/**
 * The key the Chats group takes, where a project group takes its slug.
 *
 * Still "unfiled" though the section reads "Chats": it is the persisted
 * collapse key, and renaming it would silently expand a section every user who
 * had collapsed it had already put away.
 */
export const SIDEBAR_UNFILED_GROUP_KEY = "unfiled";

/** What the section of unclaimed threads calls itself. */
export const SIDEBAR_CHATS_GROUP_TITLE = "Chats";

export interface SidebarProjectGroup {
  /** Stable across renders and unique within the view; the collapse key. */
  readonly key: string;
  /** `null` for the Chats group — there is no project home to open. */
  readonly slug: ProjectCategorySlug | null;
  readonly title: string;
  /** Chosen accent id, or empty for the one derived from the slug. */
  readonly accent: string;
  /** Chosen glyph variant, or empty for the one derived from the slug. */
  readonly glyph: string;
  /** Uploaded icon as a data URI, or empty to draw the glyph. */
  readonly icon: string;
  readonly archived: boolean;
  readonly rows: ReadonlyArray<SidebarProjectRow>;
}

export interface SidebarProjectsInput {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  /** Already resolved by the fold. Never recomputed here. */
  readonly membership: ProjectMembership;
}

export interface SidebarProjectGroups {
  /** Live projects by title. Projects only — nothing else is in this list. */
  readonly groups: ReadonlyArray<SidebarProjectGroup>;
  /**
   * Archived projects, kept out of `groups` for the caller to put behind a
   * disclosure. Returned rather than dropped because their threads are still
   * real work: hiding a group must be something the user can undo in one click,
   * and the caller needs the count to say how much is behind it.
   */
  readonly archivedGroups: ReadonlyArray<SidebarProjectGroup>;
  /**
   * Threads no project claims, for the bottom of the view. `null` when every
   * thread is filed — an empty Chats section is a header saying nothing.
   */
  readonly chatsGroup: SidebarProjectGroup | null;
}

export function buildSidebarProjectGroups(input: SidebarProjectsInput): SidebarProjectGroups {
  const rowsByThreadKey = new Map<string, SidebarProjectRow>();
  const pushRows = (
    threads: ReadonlyArray<EnvironmentThreadShell>,
    section: SidebarProjectSection,
  ) => {
    for (const thread of threads) {
      rowsByThreadKey.set(projectThreadKey(thread), { thread, section });
    }
  };
  // Section order within a group mirrors the inbox top to bottom, and the
  // insertion order of this map is what preserves it: membership hands back
  // thread keys in its own order, so reading rows out of here rather than
  // filtering the three arrays per group is what keeps a group's rows in the
  // inbox's order instead of the catalog's.
  pushRows(input.activeThreads, "active");
  pushRows(input.snoozedThreads, "snoozed");
  pushRows(input.settledThreads, "settled");
  const orderedKeys = [...rowsByThreadKey.keys()];

  const rowsFor = (threadKeys: ReadonlyArray<string>): ReadonlyArray<SidebarProjectRow> => {
    const wanted = new Set(threadKeys);
    const rows: Array<SidebarProjectRow> = [];
    for (const key of orderedKeys) {
      if (!wanted.has(key)) continue;
      const row = rowsByThreadKey.get(key);
      // A thread the catalog files but the partition never saw: filed on a
      // machine that has since dropped, or filed by id before the shell
      // arrived. It has no row to render, so it contributes nothing.
      if (row !== undefined) rows.push(row);
    }
    return rows;
  };

  const toGroup = (project: ProjectCategoryView): SidebarProjectGroup => {
    const rows = rowsFor(input.membership.threadKeysBySlug.get(project.slug) ?? []);
    return {
      key: project.slug,
      slug: project.slug,
      title: project.display.title,
      accent: project.display.accent,
      glyph: project.display.glyph,
      icon: project.display.icon,
      archived: project.archived,
      rows,
    };
  };

  const byTitle = (left: SidebarProjectGroup, right: SidebarProjectGroup) =>
    left.title.localeCompare(right.title) || left.key.localeCompare(right.key);

  const groups = input.projects
    .filter((project) => !project.archived)
    .map(toGroup)
    .toSorted(byTitle);
  const archivedGroups = input.projects
    .filter((project) => project.archived)
    .map(toGroup)
    .toSorted(byTitle);

  const chatRows = rowsFor(input.membership.unfiledThreadKeys);
  const chatsGroup: SidebarProjectGroup | null =
    chatRows.length === 0
      ? null
      : {
          key: SIDEBAR_UNFILED_GROUP_KEY,
          slug: null,
          title: SIDEBAR_CHATS_GROUP_TITLE,
          accent: "",
          glyph: "",
          icon: "",
          archived: false,
          rows: chatRows,
        };

  return { groups, archivedGroups, chatsGroup };
}

/** How many threads a collapsed archived disclosure is hiding. */
export function countSidebarProjectRows(groups: ReadonlyArray<SidebarProjectGroup>): number {
  return groups.reduce((total, group) => total + group.rows.length, 0);
}

/**
 * Collapse state rides the same persisted record the connections view borrowed
 * (`useUiStateStore.projectExpandedById`, localStorage-backed): one namespaced
 * key per group, expanded unless the user says otherwise. The namespace differs
 * from the connections view's so that collapsing a project never collapses a
 * machine that happens to share its name.
 */
export function sidebarProjectGroupExpansionKey(groupKey: string): string {
  return `sidebar-project-group:${groupKey}`;
}

export function resolveSidebarProjectGroupExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  groupKey: string,
): boolean {
  return projectExpandedById[sidebarProjectGroupExpansionKey(groupKey)] ?? true;
}
