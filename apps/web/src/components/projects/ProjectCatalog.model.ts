/**
 * Fork-owned: four machines' project catalogs, folded into one set of projects.
 *
 * Pure, and deliberately so — every rule that decides what a project *is* lives
 * here rather than in a component, because all of them are the kind of rule
 * that is easy to state and easy to get subtly wrong: which title wins when two
 * machines disagree, whether a thread that is both bound and excluded is in,
 * what an offline machine contributes.
 *
 * Three ideas, in order of how much they matter:
 *
 * 1. **The slug is the join key.** Machines are unioned by slug and nothing
 *    else. Titles are display, and a machine that missed a rename is stale, not
 *    separate.
 * 2. **Display is last-writer-wins, membership is not merged at all.** Display
 *    fields are machine-independent, so the newest `updatedAt` wins. The local
 *    half names `ProjectId`s and `ThreadId`s that only mean something on the
 *    machine that issued them, so it is kept per machine and never merged.
 * 3. **Membership is derived first, overridden second.** A thread whose project
 *    is bound to a category belongs to it for free — that is what makes the view
 *    correct on day one, before anyone has filed anything by hand.
 *
 * @module ProjectCatalogModel
 */
import type {
  EnvironmentId,
  ProjectCatalogLocation,
  ProjectCatalogSnapshot,
  ProjectCategoryDisplay,
  ProjectCategoryLocal,
  ProjectCategoryRecord,
  ProjectCategorySlug,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { toProjectCategorySlug } from "@t3tools/contracts";

import type { WorkbenchMasterCandidate } from "../workbench/Workbench.master";

/** One machine's contribution, plus why it might be contributing nothing. */
export interface ProjectCatalogEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal: boolean;
  /** `null` when the machine has not answered — see `pending` / `supported`. */
  readonly snapshot: ProjectCatalogSnapshot | null;
  /** The machine's server advertises the `projectCatalog` capability. */
  readonly supported: boolean;
  /** The connection has not reached `connected` yet. */
  readonly pending: boolean;
}

/** What one machine says about one category. Never merged with another's. */
export interface ProjectCategorySection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal: boolean;
  readonly local: ProjectCategoryLocal;
}

export interface ProjectCategoryView {
  readonly slug: ProjectCategorySlug;
  /** The winning copy: newest `updatedAt`, ties broken on environment id. */
  readonly display: ProjectCategoryDisplay;
  /** Earliest across machines — a category is as old as its first machine says. */
  readonly createdAt: string;
  readonly archived: boolean;
  /** One entry per machine that holds a record, ordered local-first. */
  readonly sections: ReadonlyArray<ProjectCategorySection>;
  /**
   * Machines whose copy of the display half is behind the winner. Not an error
   * — a machine that was asleep during a rename converges on the next write —
   * but the view can say so rather than pretending everyone agrees.
   */
  readonly staleEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

/** A machine the fold could not read, and the honest reason why. */
export interface ProjectCatalogMachineNote {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: "pending" | "unsupported" | "unreadable";
}

export interface ProjectCatalogView {
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  readonly notes: ReadonlyArray<ProjectCatalogMachineNote>;
}

const EMPTY_LOCAL: ProjectCategoryLocal = {
  bindings: [],
  threadIds: [],
  excludedThreadIds: [],
  masterThreadId: "",
  masterDefaults: { runtimeMode: "approval-required", interactionMode: "plan" },
  defaults: {},
  updatedAt: "",
};

/**
 * Which of two copies of the display half is authoritative.
 *
 * Newest `updatedAt` wins, and a tie falls back to the environment id rather
 * than to iteration order — the fold has to produce the same answer on every
 * machine, and map order is not a fact about the data.
 */
function displayWins(
  candidate: { readonly display: ProjectCategoryDisplay; readonly environmentId: EnvironmentId },
  incumbent: { readonly display: ProjectCategoryDisplay; readonly environmentId: EnvironmentId },
): boolean {
  if (candidate.display.updatedAt !== incumbent.display.updatedAt) {
    return candidate.display.updatedAt > incumbent.display.updatedAt;
  }
  return candidate.environmentId < incumbent.environmentId;
}

/**
 * Folds every machine's catalog into one set of projects.
 *
 * Order-independent by construction: sections are sorted local-first then by
 * label, projects by title, and the display winner is chosen by comparison
 * rather than by "last one seen". Feeding the same machines in a different
 * order produces the identical view, which is the property that makes this
 * testable at all.
 */
export function buildProjectCatalogView(
  environments: ReadonlyArray<ProjectCatalogEnvironmentInput>,
): ProjectCatalogView {
  const bySlug = new Map<
    ProjectCategorySlug,
    {
      display: ProjectCategoryDisplay;
      displayEnvironmentId: EnvironmentId;
      createdAt: string;
      sections: Array<ProjectCategorySection>;
      contributors: Array<{ environmentId: EnvironmentId; display: ProjectCategoryDisplay }>;
    }
  >();
  const notes: Array<ProjectCatalogMachineNote> = [];

  for (const environment of environments) {
    if (environment.snapshot === null) {
      notes.push({
        environmentId: environment.environmentId,
        label: environment.label,
        // Three different silences, and the view says which. "Pending" blames
        // the network, "unsupported" names a machine mid-rollout, and
        // "unreadable" is a connected machine that claims the capability and
        // still did not answer — the only one worth looking into.
        reason: environment.pending
          ? "pending"
          : environment.supported
            ? "unreadable"
            : "unsupported",
      });
      continue;
    }

    for (const record of environment.snapshot.categories) {
      const existing = bySlug.get(record.slug);
      const section: ProjectCategorySection = {
        environmentId: environment.environmentId,
        label: environment.label,
        isLocal: environment.isLocal,
        local: record.local,
      };
      if (existing === undefined) {
        bySlug.set(record.slug, {
          display: record.display,
          displayEnvironmentId: environment.environmentId,
          createdAt: record.createdAt,
          sections: [section],
          contributors: [{ environmentId: environment.environmentId, display: record.display }],
        });
        continue;
      }
      existing.sections.push(section);
      existing.contributors.push({
        environmentId: environment.environmentId,
        display: record.display,
      });
      if (record.createdAt < existing.createdAt) existing.createdAt = record.createdAt;
      if (
        displayWins(
          { display: record.display, environmentId: environment.environmentId },
          { display: existing.display, environmentId: existing.displayEnvironmentId },
        )
      ) {
        existing.display = record.display;
        existing.displayEnvironmentId = environment.environmentId;
      }
    }
  }

  const projects = [...bySlug.entries()]
    .map(([slug, entry]): ProjectCategoryView => {
      const sections = entry.sections.toSorted((left, right) => {
        if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
        return (
          left.label.localeCompare(right.label) ||
          left.environmentId.localeCompare(right.environmentId)
        );
      });
      const staleEnvironmentIds = entry.contributors
        .filter((contributor) => contributor.display.updatedAt < entry.display.updatedAt)
        .map((contributor) => contributor.environmentId)
        .toSorted((left, right) => left.localeCompare(right));

      return {
        slug,
        display: entry.display,
        createdAt: entry.createdAt,
        archived: entry.display.archivedAt !== null,
        sections,
        staleEnvironmentIds,
      };
    })
    .toSorted(
      (left, right) =>
        left.display.title.localeCompare(right.display.title) ||
        left.slug.localeCompare(right.slug),
    );

  return {
    projects,
    notes: notes.toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.environmentId.localeCompare(right.environmentId),
    ),
  };
}

/** The minimum a thread has to be to be filed: a machine, an id, a location. */
export interface ProjectMembershipThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

export interface ProjectMembership {
  /** `<environmentId>:<threadId>` → the one category the thread belongs to. */
  readonly slugByThreadKey: ReadonlyMap<string, ProjectCategorySlug>;
  readonly threadKeysBySlug: ReadonlyMap<ProjectCategorySlug, ReadonlyArray<string>>;
  /** Threads no category claims — the "Unfiled" card. */
  readonly unfiledThreadKeys: ReadonlyArray<string>;
}

/**
 * Takes plain strings rather than the branded ids on purpose: this is string
 * concatenation, every caller already holds the two halves, and requiring the
 * brands would make the rollup shapes carry them for no benefit.
 */
export function projectThreadKey(thread: {
  readonly environmentId: string;
  readonly id: string;
}): string {
  return `${thread.environmentId}:${thread.id}`;
}

/**
 * Which project each thread belongs to.
 *
 * ```
 * threadsOf(slug) = { t | binding(t.environmentId, t.projectId) == slug }   // derived
 *                 ∪ { t | t.id ∈ threadIds(t.environmentId, slug) }         // explicit add
 *                 \ { t | t.id ∈ excludedThreadIds(t.environmentId, slug) } // explicit remove
 * ```
 *
 * with one rule the set algebra above does not capture: **a thread has one
 * project**, so an explicit add beats a derived binding elsewhere, and beats an
 * exclusion on the same category. The registry keeps that true when it writes —
 * assigning retracts every other claim — and this keeps it true when reading a
 * file two machines edited while one of them was offline.
 *
 * Both the bindings and the explicit lists are machine-scoped, so nothing here
 * ever compares an id from one machine against a list from another.
 */
/**
 * Which category each *location* is bound to, keyed `<environmentId>:<projectId>`.
 *
 * Extracted so that "what does derivation alone say about this thread" has the
 * same answer as the derived half of `resolveProjectMembership` — including the
 * tie-break, which is the part a second copy would get wrong first.
 */
function buildSlugByBinding(
  projects: ReadonlyArray<ProjectCategoryView>,
): ReadonlyMap<string, ProjectCategorySlug> {
  // Keyed by environment as well as by id, because a `ProjectId` from one
  // machine and a `ProjectId` from another are unrelated strings that can
  // collide.
  const slugByBinding = new Map<string, ProjectCategorySlug>();
  for (const project of projects) {
    for (const section of project.sections) {
      for (const binding of section.local.bindings) {
        const key = `${section.environmentId}:${binding.projectId}`;
        // A location bound to two categories is a file two machines wrote
        // independently. Pick the lexicographically smaller slug so every
        // machine resolves it the same way rather than by read order.
        const incumbent = slugByBinding.get(key);
        if (incumbent === undefined || project.slug < incumbent)
          slugByBinding.set(key, project.slug);
      }
    }
  }
  return slugByBinding;
}

/**
 * The category a thread would land in on derivation alone — bindings only, with
 * every explicit add and exclusion ignored.
 *
 * Only one caller needs this, and it needs it for one reason: taking a thread
 * *out* of a project. Dropping the explicit opinions is not enough when the
 * thread's folder is bound, because derivation would put it straight back, so
 * the caller has to know which category to exclude it from. Membership itself
 * never asks this question — it only ever wants the answer after overrides.
 */
export function resolveDerivedProjectSlug(input: {
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  readonly thread: ProjectMembershipThread;
  readonly includeArchived?: boolean;
}): ProjectCategorySlug | null {
  const includeArchived = input.includeArchived ?? true;
  const projects = input.projects.filter((project) => includeArchived || !project.archived);
  return (
    buildSlugByBinding(projects).get(`${input.thread.environmentId}:${input.thread.projectId}`) ??
    null
  );
}

export function resolveProjectMembership(input: {
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  readonly threads: ReadonlyArray<ProjectMembershipThread>;
  /** Archived projects still own their threads unless the caller says otherwise. */
  readonly includeArchived?: boolean;
}): ProjectMembership {
  const includeArchived = input.includeArchived ?? true;
  const projects = input.projects.filter((project) => includeArchived || !project.archived);

  const slugByBinding = buildSlugByBinding(projects);
  const explicitSlugByThread = new Map<string, ProjectCategorySlug>();
  const excludedBySlugAndThread = new Set<string>();

  for (const project of projects) {
    for (const section of project.sections) {
      for (const threadId of section.local.threadIds) {
        const key = `${section.environmentId}:${threadId}`;
        const incumbent = explicitSlugByThread.get(key);
        if (incumbent === undefined || project.slug < incumbent) {
          explicitSlugByThread.set(key, project.slug);
        }
      }
      for (const threadId of section.local.excludedThreadIds) {
        excludedBySlugAndThread.add(`${project.slug}\u0000${section.environmentId}:${threadId}`);
      }
    }
  }

  const slugByThreadKey = new Map<string, ProjectCategorySlug>();
  const threadKeysBySlug = new Map<ProjectCategorySlug, Array<string>>();
  const unfiledThreadKeys: Array<string> = [];

  for (const thread of input.threads) {
    const threadKey = projectThreadKey(thread);
    const explicit = explicitSlugByThread.get(threadKey);
    const derived = slugByBinding.get(`${thread.environmentId}:${thread.projectId}`);

    const slug =
      explicit ??
      (derived !== undefined && !excludedBySlugAndThread.has(`${derived}\u0000${threadKey}`)
        ? derived
        : undefined);

    if (slug === undefined) {
      unfiledThreadKeys.push(threadKey);
      continue;
    }
    slugByThreadKey.set(threadKey, slug);
    const bucket = threadKeysBySlug.get(slug);
    if (bucket === undefined) threadKeysBySlug.set(slug, [threadKey]);
    else bucket.push(threadKey);
  }

  return { slugByThreadKey, threadKeysBySlug, unfiledThreadKeys };
}

/**
 * The master candidates for one project, in the shape `resolveWorkbenchMaster`
 * already takes.
 *
 * No signature change is needed there and none should be made: the global
 * workbench passes one candidate per machine's server setting, and a project
 * passes one candidate per machine's section. Same array, same local-first
 * resolution, same alternates switcher.
 */
export function projectMasterCandidates(
  project: ProjectCategoryView,
): ReadonlyArray<WorkbenchMasterCandidate> {
  return project.sections.map((section) => ({
    environmentId: section.environmentId,
    label: section.label,
    masterThreadId: section.local.masterThreadId,
    isLocal: section.isLocal,
  }));
}

/** How confident a seeding proposal is, and why. */
export type ProjectSeedEvidence = "repository" | "path";

export interface ProjectSeedLocation extends ProjectCatalogLocation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** One proposed new project, pre-bound to the locations that suggested it. */
export interface ProjectSeedProposal {
  readonly slug: ProjectCategorySlug;
  readonly title: string;
  readonly evidence: ProjectSeedEvidence;
  readonly locations: ReadonlyArray<ProjectSeedLocation>;
}

/** One unbound location that looks like it belongs to a project that exists. */
export interface ProjectBindSuggestion {
  readonly slug: ProjectCategorySlug;
  readonly evidence: ProjectSeedEvidence;
  readonly location: ProjectSeedLocation;
}

export interface ProjectSeedPlan {
  readonly proposals: ReadonlyArray<ProjectSeedProposal>;
  readonly bindSuggestions: ReadonlyArray<ProjectBindSuggestion>;
}

const basenameOf = (workspaceRoot: string): string => {
  const trimmed = workspaceRoot.replace(/[/\\]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
};

/**
 * The identity two locations have to share to be the same project, and how
 * strongly.
 *
 * `repositoryIdentity.canonicalKey` is the real answer — it is the same value
 * for the same git remote on four machines. The basename is a guess, and is
 * labelled as one so the seeding UI can present it differently rather than
 * quietly filing `~/scratch/api` with someone else's `api`.
 */
function locationIdentity(location: ProjectCatalogLocation): {
  readonly key: string;
  readonly evidence: ProjectSeedEvidence;
  readonly name: string;
} {
  if (location.repositoryKey !== null) {
    return {
      key: `repo:${location.repositoryKey}`,
      evidence: "repository",
      name: location.repositoryName ?? basenameOf(location.workspaceRoot),
    };
  }
  const basename = basenameOf(location.workspaceRoot);
  return { key: `path:${basename.toLowerCase()}`, evidence: "path", name: basename };
}

/**
 * What to propose the first time the projects view is opened, and what to
 * suggest thereafter.
 *
 * Two outputs because they are two different asks. A location that matches no
 * existing category seeds a **new** project across every machine that has it —
 * that is the one-click day-one flow. A location that matches a category which
 * already exists is a **bind** suggestion, because the project is already there
 * and only this machine's copy is missing a location.
 *
 * Locations already bound anywhere are ignored: a bound location is a settled
 * question, and re-proposing it every poll is how a seeding banner becomes
 * something an operator learns to dismiss without reading.
 */
export function buildProjectSeedPlan(input: {
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  readonly locations: ReadonlyArray<ProjectSeedLocation>;
  /**
   * Machines whose catalog this fold could not read — pending, unsupported or
   * unreadable, i.e. every `ProjectCatalogMachineNote`.
   *
   * Their locations are dropped, and that is a safety rule rather than tidiness.
   * Both outputs here lead to a write that **replaces a machine's whole binding
   * set**, and the set to preserve is read from the folded view. A machine that
   * did not answer contributes no section, so that read returns empty — and an
   * empty "existing" set is an erase, not a no-op. Offering an action against a
   * machine whose state is unknown is how a stale locations page (a separate,
   * slower poll that keeps serving its last good answer) unbinds folders nobody
   * touched.
   *
   * Unavailable is not empty. Invariant 12.
   */
  readonly silentEnvironmentIds?: ReadonlyArray<EnvironmentId>;
}): ProjectSeedPlan {
  const silent = new Set(input.silentEnvironmentIds ?? []);
  // What each existing category already looks like, so an unbound location can
  // be matched against a project rather than against a naked string.
  const slugByIdentity = new Map<string, ProjectCategorySlug>();
  for (const project of input.projects) {
    for (const section of project.sections) {
      for (const binding of section.local.bindings) {
        const bound = input.locations.find(
          (location) =>
            location.environmentId === section.environmentId &&
            location.projectId === binding.projectId,
        );
        if (bound === undefined) continue;
        const identity = locationIdentity(bound);
        const incumbent = slugByIdentity.get(identity.key);
        if (incumbent === undefined || project.slug < incumbent) {
          slugByIdentity.set(identity.key, project.slug);
        }
      }
    }
    // A category with no bound location anywhere can still be matched by name,
    // which is what makes seeding idempotent: run it twice and the second run
    // proposes nothing.
    const bySlug = `slug:${project.slug}`;
    if (!slugByIdentity.has(bySlug)) slugByIdentity.set(bySlug, project.slug);
  }

  const unbound = input.locations.filter(
    (location) => location.boundSlug === null && !silent.has(location.environmentId),
  );

  const bindSuggestions: Array<ProjectBindSuggestion> = [];
  const groups = new Map<
    string,
    { evidence: ProjectSeedEvidence; name: string; locations: Array<ProjectSeedLocation> }
  >();

  for (const location of unbound) {
    const identity = locationIdentity(location);
    const existing =
      slugByIdentity.get(identity.key) ??
      slugByIdentity.get(`slug:${toProjectCategorySlug(identity.name) ?? ""}`);
    if (existing !== undefined) {
      bindSuggestions.push({ slug: existing, evidence: identity.evidence, location });
      continue;
    }
    const group = groups.get(identity.key);
    if (group === undefined) {
      groups.set(identity.key, {
        evidence: identity.evidence,
        name: identity.name,
        locations: [location],
      });
    } else {
      group.locations.push(location);
    }
  }

  const proposals: Array<ProjectSeedProposal> = [];
  const claimed = new Set<ProjectCategorySlug>(input.projects.map((project) => project.slug));
  for (const group of groups.values()) {
    const base = toProjectCategorySlug(group.name);
    if (base === null) continue;
    // Two different repositories can share a name. Suffix rather than merge:
    // the operator can rename either afterwards, and a collision that silently
    // merged two repositories would be the one mistake this flow must not make.
    let slug = base;
    let suffix = 2;
    while (claimed.has(slug)) {
      slug = `${base}-${suffix}` as ProjectCategorySlug;
      suffix += 1;
    }
    claimed.add(slug);
    proposals.push({
      slug,
      title: group.name,
      evidence: group.evidence,
      locations: group.locations.toSorted(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.environmentId.localeCompare(right.environmentId),
      ),
    });
  }

  return {
    proposals: proposals.toSorted(
      (left, right) => left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug),
    ),
    bindSuggestions: bindSuggestions.toSorted(
      (left, right) =>
        left.slug.localeCompare(right.slug) ||
        left.location.label.localeCompare(right.location.label) ||
        left.location.workspaceRoot.localeCompare(right.location.workspaceRoot),
    ),
  };
}

/**
 * One machine's section, or an empty one.
 *
 * The empty section is not a placeholder for a missing answer — it is the
 * honest state of a machine that holds no record for this category, which is
 * every machine until someone binds a location there.
 */
export function projectSectionFor(
  project: ProjectCategoryView,
  environmentId: EnvironmentId,
): ProjectCategoryLocal {
  return (
    project.sections.find((section) => section.environmentId === environmentId)?.local ??
    EMPTY_LOCAL
  );
}

/** Convenience for the write path: this machine's record, if it has one. */
export function projectHasSection(
  project: ProjectCategoryView,
  environmentId: EnvironmentId,
): boolean {
  return project.sections.some((section) => section.environmentId === environmentId);
}

/**
 * The display half as a patch, for fanning a category out to a machine that
 * does not have it yet. Never carries the local half — that is the invariant
 * the whole registry design rests on.
 */
export function projectDisplayPatch(record: ProjectCategoryRecord | ProjectCategoryView): {
  readonly title: string;
  readonly summary: string;
  readonly accent: string;
  readonly glyph: string;
  readonly parentSlug: ProjectCategorySlug | null;
  readonly links: ProjectCategoryDisplay["links"];
  readonly notes: string;
  readonly archivedAt: string | null;
} {
  const display = record.display;
  return {
    title: display.title,
    summary: display.summary,
    accent: display.accent,
    glyph: display.glyph,
    parentSlug: display.parentSlug,
    links: display.links,
    notes: display.notes,
    archivedAt: display.archivedAt,
  };
}

/**
 * A display write the client has issued but has not read back yet.
 *
 * The catalog is polled, not pushed, so without this a rename would sit at its
 * old title for up to the poll interval even after every machine took it. The
 * overlay is deliberately display-only: the local half is written to exactly
 * one machine and read back from it, and guessing at membership would be
 * guessing about ids this client does not own.
 */
export interface PendingProjectDisplay {
  readonly slug: ProjectCategorySlug;
  readonly display: Partial<ProjectCategoryDisplay>;
  /** The `displayUpdatedAt` the write carried. Also its expiry condition. */
  readonly stamp: string;
  /** Set when the write created the category, so it can render before any read. */
  readonly created: boolean;
}

/**
 * How long a *created* project may be claimed by the overlay and by no machine.
 *
 * The catalog is polled roughly every 45 seconds, so this is two polls plus
 * slack: long enough that a create which landed is never blinked out from under
 * the operator, short enough that a create which did not land stops pretending.
 */
export const PENDING_PROJECT_CREATE_GRACE_MS = 120_000;

/**
 * Folds pending writes over the last read.
 *
 * A write *against an existing project* is self-clearing by construction: the
 * entry survives only while the folded record is older than the write that
 * produced it, so the first poll returning the new title drops the overlay in
 * the same pass.
 *
 * A write that CREATED a project has no such anchor, and that asymmetry was a
 * bug worth naming, because it produced ghosts. If no machine ever accepts the
 * create — every machine refused it, or none was reachable, or the capability
 * was missing — there is no record for the fold to catch up to, so the
 * synthesized card below rendered for the rest of the session and no reload of
 * the projects view could clear it. A project that exists nowhere but on the
 * operator's screen is worse than a create that visibly failed, so a created
 * entry is now given `PENDING_PROJECT_CREATE_GRACE_MS` to be confirmed by
 * somebody and is dropped after that.
 *
 * Note what still holds after the grace: a *rename* to a machine that is
 * permanently gone keeps showing the operator's own text, because there the
 * project genuinely exists and the alternative is silently reverting an edit
 * they made.
 */
export function applyPendingProjectDisplays(
  view: ProjectCatalogView,
  pending: ReadonlyArray<PendingProjectDisplay>,
  nowMs: number = Date.now(),
): ProjectCatalogView {
  if (pending.length === 0) return view;

  const bySlug = new Map<ProjectCategorySlug, PendingProjectDisplay>();
  for (const entry of pending) {
    const incumbent = bySlug.get(entry.slug);
    if (incumbent === undefined || entry.stamp > incumbent.stamp) bySlug.set(entry.slug, entry);
  }

  const projects = view.projects.map((project) => {
    const entry = bySlug.get(project.slug);
    if (entry === undefined) return project;
    bySlug.delete(project.slug);
    // The read has caught up: the overlay has nothing left to say.
    if (project.display.updatedAt >= entry.stamp) return project;
    const display = { ...project.display, ...entry.display, updatedAt: entry.stamp };
    return { ...project, display, archived: display.archivedAt !== null };
  });

  // Anything still in the map is a category created a moment ago that no
  // machine has reported back yet. Rendering it immediately is the difference
  // between "new project" feeling instant and feeling broken — but only for as
  // long as "a moment ago" is true. Past the grace, nobody took it, and the
  // honest answer is that the project is not there.
  const created = [...bySlug.values()]
    .filter(
      (entry) => entry.created && nowMs - Date.parse(entry.stamp) < PENDING_PROJECT_CREATE_GRACE_MS,
    )
    .map(
      (entry): ProjectCategoryView => ({
        slug: entry.slug,
        display: {
          title: entry.slug,
          summary: "",
          accent: "",
          glyph: "",
          parentSlug: null,
          links: [],
          notes: "",
          archivedAt: null,
          ...entry.display,
          updatedAt: entry.stamp,
        },
        createdAt: entry.stamp,
        archived: entry.display.archivedAt != null,
        sections: [],
        staleEnvironmentIds: [],
      }),
    );

  return {
    ...view,
    projects: [...projects, ...created].toSorted(
      (left, right) =>
        left.display.title.localeCompare(right.display.title) ||
        left.slug.localeCompare(right.slug),
    ),
  };
}
