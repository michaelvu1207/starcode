/**
 * Where a new thread for a project should be started.
 *
 * "New thread in Alpamayo" is a question a category cannot answer on its own. A
 * category is a label across machines; a thread needs a *place* — one machine,
 * one folder, because that folder is the thread's cwd and decides where its
 * worktree, its git history and its files are. So the affordance has to pick a
 * location, and this is how it decides which ones to offer.
 *
 * Every location offered is in the project. Clicking "new thread" on a project
 * means a thread in that project, so an out-of-project start is not one of the
 * answers — the caller files the new thread into the category by id either way
 * (`useProjectThreadStarter`), which is what makes that true even where the
 * folder itself is unclaimed. What is left to decide is therefore not *whether*
 * you land in the project but *which machine* you land on, and that is what the
 * picker asks: locations come out grouped by connection, so the visible choice
 * is the machine.
 *
 * Bound folders answer it when there are any. A binding is the operator saying
 * "work in this folder belongs to this project", which makes it the answer to
 * "where does this project's work happen" by definition. Several bindings on one
 * connection all show, each as its own row under that machine — two checkouts of
 * the same project on one machine is a normal thing to have and only the
 * operator knows which one they meant.
 *
 * With no bound folder anywhere, every connection is offered with one default
 * folder each. A project with no bindings is a legal and common state — every
 * project created by hand starts that way — and refusing to start a thread in
 * one would make "New project" a dead end. One folder per machine rather than
 * every folder on every machine keeps the question the same question it is in
 * the bound case: which machine, not which of forty directories.
 *
 * A binding whose folder no longer exists is dropped rather than offered. The
 * registry keeps ids the machine may since have forgotten — a folder removed
 * from the server, or a machine that is currently unreachable — and an entry
 * that cannot be started in is worse than one that is missing. A project whose
 * every binding drops that way falls back to the defaults above rather than to
 * nothing, for the same reason a hand-made project does.
 */
import type { EnvironmentId, ProjectId } from "@starcode/contracts";

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

/** One machine's worth of the picker: the group header and its rows. */
export interface ProjectStartConnection {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly isLocalMachine: boolean;
  /** Never empty — a machine with nothing to start in is not listed. */
  readonly locations: ReadonlyArray<ProjectStartLocation>;
}

/**
 * The machine's default folder for a project that has claimed none of them.
 *
 * A folder named after the project is the answer whenever there is one: a
 * hand-made project called "Alpamayo" and a checkout called `alpamayo` on the
 * hub are the same thing often enough that offering anything else would read as
 * a mistake. With no such folder there is nothing to prefer, so the first by
 * name wins — an arbitrary choice, but a *stable* one, which is what matters
 * when the operator is about to learn where their thread lives from this row.
 */
function defaultFolderFor(
  projectTitle: string,
  folders: ReadonlyArray<ProjectStartFolder>,
): ProjectStartFolder | undefined {
  const wanted = comparableName(projectTitle);
  const named =
    wanted === "" ? undefined : folders.find((folder) => comparableName(folder.title) === wanted);
  return named ?? folders.toSorted(byTitleThenId)[0];
}

function byTitleThenId(left: ProjectStartFolder, right: ProjectStartFolder): number {
  return left.title.localeCompare(right.title) || left.projectId.localeCompare(right.projectId);
}

/** Names match when only case and separators differ: "Agent Hub" is `agent-hub`. */
function comparableName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

export function resolveProjectStartConnections(input: {
  readonly project: ProjectCategoryView;
  /** Every folder every machine reports, in any order. */
  readonly folders: ReadonlyArray<ProjectStartFolder>;
}): ReadonlyArray<ProjectStartConnection> {
  const boundKeys = new Set<string>();
  for (const section of input.project.sections) {
    for (const binding of section.local.bindings) {
      boundKeys.add(`${section.environmentId}:${binding.projectId}`);
    }
  }

  const bound = input.folders.filter((folder) =>
    boundKeys.has(`${folder.environmentId}:${folder.projectId}`),
  );
  const offered: ReadonlyArray<ProjectStartLocation> =
    bound.length > 0
      ? bound.map((folder) => ({ ...folder, bound: true }))
      : defaultsPerConnection(input.project.display.title, input.folders).map((folder) => ({
          ...folder,
          bound: false,
        }));

  return groupByConnection(offered);
}

function defaultsPerConnection(
  projectTitle: string,
  folders: ReadonlyArray<ProjectStartFolder>,
): ReadonlyArray<ProjectStartFolder> {
  const byConnection = new Map<EnvironmentId, Array<ProjectStartFolder>>();
  for (const folder of folders) {
    const existing = byConnection.get(folder.environmentId);
    if (existing) existing.push(folder);
    else byConnection.set(folder.environmentId, [folder]);
  }

  const defaults: Array<ProjectStartFolder> = [];
  for (const candidates of byConnection.values()) {
    const chosen = defaultFolderFor(projectTitle, candidates);
    if (chosen !== undefined) defaults.push(chosen);
  }
  return defaults;
}

/**
 * This machine leads, then the rest by name.
 *
 * A new thread is usually one you are about to type into, and typing into a
 * remote machine's checkout is a choice rather than a default.
 */
function groupByConnection(
  locations: ReadonlyArray<ProjectStartLocation>,
): ReadonlyArray<ProjectStartConnection> {
  const byConnection = new Map<EnvironmentId, Array<ProjectStartLocation>>();
  for (const location of locations) {
    const existing = byConnection.get(location.environmentId);
    if (existing) existing.push(location);
    else byConnection.set(location.environmentId, [location]);
  }

  const connections: Array<ProjectStartConnection> = [];
  for (const [environmentId, group] of byConnection) {
    const first = group[0];
    if (first === undefined) continue;
    connections.push({
      environmentId,
      machineLabel: first.machineLabel,
      isLocalMachine: first.isLocalMachine,
      locations: group.toSorted(byTitleThenId),
    });
  }

  return connections.toSorted((left, right) => {
    if (left.isLocalMachine !== right.isLocalMachine) return left.isLocalMachine ? -1 : 1;
    return (
      left.machineLabel.localeCompare(right.machineLabel) ||
      left.environmentId.localeCompare(right.environmentId)
    );
  });
}

/** Every location the picker would offer, connection order preserved. */
export function flattenProjectStartConnections(
  connections: ReadonlyArray<ProjectStartConnection>,
): ReadonlyArray<ProjectStartLocation> {
  return connections.flatMap((connection) => connection.locations);
}

/**
 * Whether the caller may start without asking.
 *
 * One bound folder is not a choice — it is where this project's work happens,
 * and putting a menu in front of it would be ceremony. Anything else is a
 * decision the operator should see, including "several bound folders" (which of
 * your checkouts, on which machine?) and "none bound" (this thread is about to
 * land somewhere the project has never claimed, so say where — one candidate is
 * not the same as no decision).
 */
export function resolveUnambiguousStartLocation(
  connections: ReadonlyArray<ProjectStartConnection>,
): ProjectStartLocation | null {
  const bound = flattenProjectStartConnections(connections).filter((location) => location.bound);
  return bound.length === 1 ? (bound[0] ?? null) : null;
}
