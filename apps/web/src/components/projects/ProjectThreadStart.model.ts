/**
 * Where a new thread for a project should be started.
 *
 * "New thread in Alpamayo" is a question a category cannot answer on its own. A
 * category is a label across machines; a thread needs a *place* — one machine,
 * one folder, because that folder is the thread's cwd and decides where its
 * worktree, its git history and its files are. So the affordance has to pick a
 * location, and this is the ranking it picks by.
 *
 * Bound folders lead. A binding is the operator saying "work in this folder
 * belongs to this project", which makes it the answer to "where does this
 * project's work happen" by definition — and a thread started in one is a
 * member the instant it exists, with no membership write at all. Among bound
 * folders, this machine before the others: a new thread is usually one you are
 * about to type into, and typing into a remote machine's checkout is a choice
 * rather than a default.
 *
 * Unbound folders follow rather than being excluded, because a project with no
 * bindings is a legal and common state — every project created by hand starts
 * that way, and refusing to start a thread in one would make "New project" a
 * dead end. Starting somewhere unbound is fine; the caller files the thread
 * explicitly afterwards.
 *
 * A binding whose folder no longer exists is dropped rather than offered. The
 * registry keeps ids the machine may since have forgotten — a folder removed
 * from the server, or a machine that is currently unreachable — and an entry
 * that cannot be started in is worse than one that is missing.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ProjectCategoryView } from "./ProjectCatalog.model";

/** A folder on a machine, as this picker needs to see it. */
export interface ProjectStartFolder {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The folder's own name. */
  readonly title: string;
  readonly machineLabel: string;
  readonly isLocalMachine: boolean;
}

export interface ProjectStartLocation extends ProjectStartFolder {
  /** The project already claims this folder, so membership needs no write. */
  readonly bound: boolean;
}

export function resolveProjectStartLocations(input: {
  readonly project: ProjectCategoryView;
  readonly folders: ReadonlyArray<ProjectStartFolder>;
}): ReadonlyArray<ProjectStartLocation> {
  const boundKeys = new Set<string>();
  for (const section of input.project.sections) {
    for (const binding of section.local.bindings) {
      boundKeys.add(`${section.environmentId}:${binding.projectId}`);
    }
  }

  const ranked = input.folders.map((folder) => ({
    ...folder,
    bound: boundKeys.has(`${folder.environmentId}:${folder.projectId}`),
  }));

  return ranked.toSorted((left, right) => {
    if (left.bound !== right.bound) return left.bound ? -1 : 1;
    if (left.isLocalMachine !== right.isLocalMachine) return left.isLocalMachine ? -1 : 1;
    return (
      left.title.localeCompare(right.title) ||
      left.machineLabel.localeCompare(right.machineLabel) ||
      left.projectId.localeCompare(right.projectId)
    );
  });
}

/**
 * Whether the caller may start without asking.
 *
 * One bound folder is not a choice — it is where this project's work happens,
 * and putting a menu in front of it would be ceremony. Anything else is a
 * decision the operator should see, including "several bound folders" (which of
 * your checkouts?) and "none bound" (this thread is about to land somewhere the
 * project has never claimed, so say where).
 */
export function resolveUnambiguousStartLocation(
  locations: ReadonlyArray<ProjectStartLocation>,
): ProjectStartLocation | null {
  const bound = locations.filter((location) => location.bound);
  return bound.length === 1 ? (bound[0] ?? null) : null;
}
