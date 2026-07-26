/**
 * Fork-owned: projects as cross-machine categories.
 *
 * A server `project` is a *location* — a folder on one machine, and the only
 * source of a thread's cwd. That record is load-bearing infrastructure and F16
 * does not touch it. This file adds the layer above it: a category the operator
 * names, keyed by a slug rather than a path, that the same repository on four
 * machines can all point at.
 *
 * **The split down the middle of every record is the whole design.** A category
 * has two halves and they replicate differently:
 *
 * - `display` — what the category *is*. Title, summary, glyph, notes, links,
 *   archive state, and (reserved) `parentSlug`. Machine-independent, so the
 *   client fans a display write out to every reachable machine, and the fold
 *   breaks ties on `display.updatedAt` so the newest title wins even when one
 *   machine missed the write.
 * - `local` — what this machine contributes. Bound locations, explicitly filed
 *   and excluded threads, the master thread, defaults. Every id in here is
 *   machine-scoped (`ProjectId` and `ThreadId` are only meaningful on the
 *   server that issued them), so **`local` is never replicated**. Each machine
 *   is the sole author of its own half, which is what keeps a registry with no
 *   coordinator conflict-free.
 *
 * The nesting is deliberate rather than cosmetic: it makes "which fields fan
 * out" a type rather than a comment, so a fan-out write cannot silently carry a
 * `masterThreadId` to a machine that has never heard of that thread.
 *
 * @module ProjectCatalog
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatform } from "./environment.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProjectCategorySlug } from "./projectCategorySlug.ts";
import { PROJECT_CATEGORY_ICON_MAX_LENGTH, ProjectCategoryIconDataUri } from "./projectIcon.ts";
import { WorkbenchMasterDefaults } from "./settings.ts";

// The slug is defined in its own leaf module to keep `peers.ts` out of a
// module cycle; re-exported here so it stays part of this contract's surface.
export {
  PROJECT_CATEGORY_SLUG_MAX_LENGTH,
  ProjectCategorySlug,
  toProjectCategorySlug,
} from "./projectCategorySlug.ts";

// Same arrangement for the icon, which the browser encoder and the server
// validator both need without either reaching the rest of this module.
export {
  describeProjectCategoryIconRejection,
  PROJECT_CATEGORY_ICON_MAX_LENGTH,
  PROJECT_CATEGORY_ICON_MIME_TYPES,
  PROJECT_CATEGORY_ICON_TARGET_SIZE,
  ProjectCategoryIconDataUri,
  validateProjectCategoryIcon,
  type ProjectCategoryIconMimeType,
  type ProjectCategoryIconRejection,
} from "./projectIcon.ts";

export const PROJECT_CATEGORY_TITLE_MAX_LENGTH = 200;
export const PROJECT_CATEGORY_SUMMARY_MAX_LENGTH = 500;
export const PROJECT_CATEGORY_NOTES_MAX_LENGTH = 16_000;
export const PROJECT_CATEGORY_LINK_MAX_COUNT = 32;

export const ProjectCategoryLink = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type ProjectCategoryLink = typeof ProjectCategoryLink.Type;

/**
 * The replicated half. Everything here is safe to copy verbatim onto another
 * machine, and `updatedAt` is what the fold sorts on when two copies disagree.
 */
export const ProjectCategoryDisplay = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_CATEGORY_TITLE_MAX_LENGTH)),
  summary: Schema.String.check(Schema.isMaxLength(PROJECT_CATEGORY_SUMMARY_MAX_LENGTH)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  /** Theme token name. Empty means "derive one from the slug hash". */
  accent: Schema.String.check(Schema.isMaxLength(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  /** Constellation glyph id. Empty means "derive one from the slug hash". */
  glyph: Schema.String.check(Schema.isMaxLength(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  /**
   * An uploaded mark, as a base64 data URI. Empty — the default, and what every
   * project starts as — means "draw the constellation `glyph` names".
   *
   * Capped but not sniffed here, unlike the patch below: the strict schema
   * belongs on the write, and a stored value that somehow fails it must still
   * decode rather than take the machine's whole catalog down with it. The
   * renderer falls back to the constellation when the image will not load, so a
   * bad string costs one project its picture and nothing else.
   */
  icon: Schema.String.check(Schema.isMaxLength(PROJECT_CATEGORY_ICON_MAX_LENGTH)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  /**
   * Reserved. Projects are flat in v1 — nothing reads this yet — but a field
   * is far cheaper to reserve than to retrofit once four machines hold records.
   */
  parentSlug: Schema.NullOr(ProjectCategorySlug).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  links: Schema.Array(ProjectCategoryLink)
    .check(Schema.isMaxLength(PROJECT_CATEGORY_LINK_MAX_COUNT))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Operator-authored markdown. Read by the project MCP tools verbatim. */
  notes: Schema.String.check(Schema.isMaxLength(PROJECT_CATEGORY_NOTES_MAX_LENGTH)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Last write to *this* half, anywhere. The fold's tie-break. */
  updatedAt: IsoDateTime,
});
export type ProjectCategoryDisplay = typeof ProjectCategoryDisplay.Type;

/**
 * What a category's master starts as before anyone changes it — the same pair
 * `WorkbenchMasterDefaults` decodes to, spelled out because a *constructed*
 * record (as opposed to a decoded one) has to supply both fields.
 */
export const DEFAULT_PROJECT_CATEGORY_MASTER_DEFAULTS: WorkbenchMasterDefaults = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

/** A local server-project filed under this category. */
export const ProjectCategoryBinding = Schema.Struct({
  projectId: ProjectId,
  boundAt: IsoDateTime,
});
export type ProjectCategoryBinding = typeof ProjectCategoryBinding.Type;

/**
 * What a thread created from this project's home starts with.
 *
 * Machine-local rather than replicated because two of the three fields name
 * machine-scoped things: a `ProviderInstanceId` inside `modelSelection` is this
 * server's provider config, and `preferredProjectId` is a local location.
 */
export const ProjectCategoryDefaults = Schema.Struct({
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  preferredProjectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
});
export type ProjectCategoryDefaults = typeof ProjectCategoryDefaults.Type;

/**
 * The machine-local half. Never replicated, never merged — the fold keys this
 * per environment and hands the caller one section per machine.
 */
export const ProjectCategoryLocal = Schema.Struct({
  bindings: Schema.Array(ProjectCategoryBinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Threads that belong here regardless of where their cwd points. */
  threadIds: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Threads that do not belong here despite a bound location saying otherwise. */
  excludedThreadIds: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * This machine's orchestrator for this category. A plain string, empty when
   * none is designated — the same idiom, and the same meaning, as
   * `ServerSettings.workbenchMasterThreadId`, which stays in place as the
   * global `/workbench` master.
   */
  masterThreadId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  masterDefaults: WorkbenchMasterDefaults.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  defaults: ProjectCategoryDefaults.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Last write to *this* half, on this machine. Never compared across machines. */
  updatedAt: IsoDateTime,
});
export type ProjectCategoryLocal = typeof ProjectCategoryLocal.Type;

export const ProjectCategoryRecord = Schema.Struct({
  slug: ProjectCategorySlug,
  /** Earliest wins in the fold: a category is as old as its first machine says. */
  createdAt: IsoDateTime,
  display: ProjectCategoryDisplay,
  local: ProjectCategoryLocal,
});
export type ProjectCategoryRecord = typeof ProjectCategoryRecord.Type;

export const ProjectCatalogSnapshot = Schema.Struct({
  categories: Schema.Array(ProjectCategoryRecord),
  computedAt: IsoDateTime,
});
export type ProjectCatalogSnapshot = typeof ProjectCatalogSnapshot.Type;

/**
 * A location this machine could bind, with the identity a seeder groups on.
 *
 * Deliberately raw: `repositoryKey` is `repositoryIdentity.canonicalKey`
 * straight off the projection, not a derived grouping key. Deriving here would
 * be a second implementation of `deriveLogicalProjectKey`, and the two would
 * drift the first time one of them learned something about monorepo subpaths.
 * The suggestion is computed once, in the client's pure fold, from this.
 */
export const ProjectCatalogLocation = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  repositoryName: Schema.NullOr(TrimmedNonEmptyString),
  /** The category this machine has already bound it to, if any. */
  boundSlug: Schema.NullOr(ProjectCategorySlug),
});
export type ProjectCatalogLocation = typeof ProjectCatalogLocation.Type;

export const ProjectCatalogLocationsPage = Schema.Struct({
  locations: Schema.Array(ProjectCatalogLocation),
  computedAt: IsoDateTime,
});
export type ProjectCatalogLocationsPage = typeof ProjectCatalogLocationsPage.Type;

/**
 * A partial write. Absent field means "leave it", which is what makes a
 * fan-out write safe: the client sends `display` to every machine and `local`
 * to exactly one, and neither clobbers the other half.
 */
export const ProjectCategoryDisplayPatch = Schema.Struct({
  title: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_CATEGORY_TITLE_MAX_LENGTH)),
  ),
  summary: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROJECT_CATEGORY_SUMMARY_MAX_LENGTH)),
  ),
  accent: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  glyph: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /**
   * Strict here and nowhere else. This is the only door bytes come through —
   * the HTTP upsert, the MCP tool and the fan-out all decode this patch — so
   * refusing an oversize or mistyped image at the schema costs every write path
   * one shared implementation instead of three that drift. Empty clears it.
   */
  icon: Schema.optionalKey(ProjectCategoryIconDataUri),
  parentSlug: Schema.optionalKey(Schema.NullOr(ProjectCategorySlug)),
  links: Schema.optionalKey(
    Schema.Array(ProjectCategoryLink).check(Schema.isMaxLength(PROJECT_CATEGORY_LINK_MAX_COUNT)),
  ),
  notes: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROJECT_CATEGORY_NOTES_MAX_LENGTH)),
  ),
  archivedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
});
export type ProjectCategoryDisplayPatch = typeof ProjectCategoryDisplayPatch.Type;

export const ProjectCategoryLocalPatch = Schema.Struct({
  /** Replaces the whole set. `boundAt` is preserved for bindings that survive. */
  bindings: Schema.optionalKey(Schema.Array(ProjectId)),
  threadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  excludedThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  masterThreadId: Schema.optionalKey(Schema.String),
  masterDefaults: Schema.optionalKey(WorkbenchMasterDefaults),
  defaults: Schema.optionalKey(ProjectCategoryDefaults),
});
export type ProjectCategoryLocalPatch = typeof ProjectCategoryLocalPatch.Type;

export const ProjectCatalogUpsertRequest = Schema.Struct({
  slug: ProjectCategorySlug,
  display: Schema.optionalKey(ProjectCategoryDisplayPatch),
  local: Schema.optionalKey(ProjectCategoryLocalPatch),
  /**
   * The authoring timestamp for the display half.
   *
   * The client stamps one value and sends it to every machine, so a rename
   * converges on the value the operator's clock produced rather than racing on
   * four machines' clocks. Absent means "use this server's clock", which is
   * what a direct `curl` or an MCP call gets.
   */
  displayUpdatedAt: Schema.optionalKey(IsoDateTime),
});
export type ProjectCatalogUpsertRequest = typeof ProjectCatalogUpsertRequest.Type;

export const ProjectCatalogUpsertResult = Schema.Struct({
  category: ProjectCategoryRecord,
  created: Schema.Boolean,
});
export type ProjectCatalogUpsertResult = typeof ProjectCatalogUpsertResult.Type;

export const ProjectCatalogRemoveRequest = Schema.Struct({ slug: ProjectCategorySlug });
export type ProjectCatalogRemoveRequest = typeof ProjectCatalogRemoveRequest.Type;

export const ProjectCatalogRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type ProjectCatalogRemoveResult = typeof ProjectCatalogRemoveResult.Type;

/**
 * Filing a thread.
 *
 * - `assign` — this thread belongs to this category, whatever its cwd says.
 *   Removes it from every other category on this machine, because a thread has
 *   one project.
 * - `exclude` — this thread does *not* belong to this category, even though a
 *   bound location puts it there. The only way to take a derived thread out.
 * - `unfile` — drop every explicit opinion this machine holds about the thread
 *   and let derivation decide again. `slug` is meaningless here and must be null.
 *
 * Modelled as one struct with a nullable slug rather than as a three-member
 * union of the shapes each mode actually takes, which is what this wants to be.
 * The generated HTTP client distributes a union payload across its parameter
 * type, so a caller holding an undiscriminated request could not pass it
 * through without narrowing at every call site. The cost is one precondition
 * the server checks (`assign`/`exclude` need a slug) instead of a request the
 * decoder could have rejected.
 */
export const ProjectCatalogFileThreadMode = Schema.Literals(["assign", "exclude", "unfile"]);
export type ProjectCatalogFileThreadMode = typeof ProjectCatalogFileThreadMode.Type;

export const ProjectCatalogFileThreadRequest = Schema.Struct({
  mode: ProjectCatalogFileThreadMode,
  threadId: ThreadId,
  slug: Schema.NullOr(ProjectCategorySlug),
});
export type ProjectCatalogFileThreadRequest = typeof ProjectCatalogFileThreadRequest.Type;

/**
 * The one precondition the schema cannot carry: which modes need a slug.
 *
 * Lives here rather than in the handler so the client can refuse to send a
 * request the server would reject, and so both sides agree on what "valid"
 * means without one of them reimplementing it.
 */
export function isValidProjectCatalogFileThreadRequest(
  request: ProjectCatalogFileThreadRequest,
): boolean {
  return request.mode === "unfile" ? request.slug === null : request.slug !== null;
}

/**
 * Which threads on **one machine** belong to a category.
 *
 * ```
 * threadsOf(slug) = { t | t.projectId ∈ bindings(slug) }   // derived from cwd
 *                 ∪ { t | t.id ∈ threadIds(slug) }         // explicit add
 *                 \ { t | t.id ∈ excludedThreadIds(slug) } // explicit remove
 * ```
 *
 * Lives in contracts, beside the record it reads, because two callers need the
 * same answer and a second implementation would eventually give a different
 * one: the MCP tools resolve it here, and the web client's
 * `ProjectCatalog.model.ts` resolves the **cross-machine** generalisation of it
 * over folded sections. This is the single-machine case — no environment
 * scoping is needed because every id in a record already belongs to the machine
 * that wrote it.
 *
 * A thread has one project, so the two ways it can be claimed twice are settled
 * the same way the client settles them: an explicit add beats a derived
 * binding, and two categories claiming it at the same strength are broken on
 * the lexicographically smaller slug so the answer never depends on file order.
 */
export function resolveLocalProjectMembership(input: {
  readonly categories: ReadonlyArray<ProjectCategoryRecord>;
  readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly projectId: ProjectId }>;
}): ReadonlyMap<ProjectCategorySlug, ReadonlyArray<ThreadId>> {
  const slugByBoundProject = new Map<ProjectId, ProjectCategorySlug>();
  const slugByExplicitThread = new Map<ThreadId, ProjectCategorySlug>();
  const excluded = new Set<string>();

  for (const category of orderedBySlug(input.categories)) {
    for (const binding of category.local.bindings) {
      if (!slugByBoundProject.has(binding.projectId)) {
        slugByBoundProject.set(binding.projectId, category.slug);
      }
    }
    for (const threadId of category.local.threadIds) {
      if (!slugByExplicitThread.has(threadId)) slugByExplicitThread.set(threadId, category.slug);
    }
    for (const threadId of category.local.excludedThreadIds) {
      excluded.add(`${category.slug} ${threadId}`);
    }
  }

  const bySlug = new Map<ProjectCategorySlug, Array<ThreadId>>();
  for (const thread of input.threads) {
    const explicit = slugByExplicitThread.get(thread.id);
    const derived = slugByBoundProject.get(thread.projectId);
    const slug =
      explicit ??
      (derived !== undefined && !excluded.has(`${derived} ${thread.id}`) ? derived : undefined);
    if (slug === undefined) continue;
    const bucket = bySlug.get(slug);
    if (bucket === undefined) bySlug.set(slug, [thread.id]);
    else bucket.push(thread.id);
  }
  return bySlug;
}

/**
 * Slug order, so "first claim wins" above means "smallest slug wins".
 *
 * Code-point comparison, deliberately, and not `localeCompare`: with no locale
 * argument that resolves against the *process's* default locale, which Node
 * takes from the environment. A server running under `da_DK` orders `aa-sim`
 * after `zz-sim`, so the same double claim would be broken one way by this
 * resolver and the other way by the client's cross-machine fold — which
 * compares with `<` — and the two halves of one screen would disagree about
 * which project a thread is in. "Never by file order" is not enough; it has to
 * be the same answer everywhere, and only a locale-free comparison is.
 */
const orderedBySlug = (
  categories: ReadonlyArray<ProjectCategoryRecord>,
): ReadonlyArray<ProjectCategoryRecord> =>
  categories.toSorted((left, right) =>
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0,
  );

/**
 * The project tools, as an agent sees them.
 *
 * This is the half of F16 that makes "organized through the tool calls" real.
 * Two reads open to every session, because an agent that knows which project it
 * is working in writes better commits and asks better questions; one write that
 * is open for the caller's *own* thread and gated for anyone else's.
 *
 * Everything here is scoped to the machine answering. A tool result never
 * claims to know what another machine holds — the cross-machine union is the
 * client's fold, and a server that guessed at it would be inventing.
 */
export const ProjectToolOperation = Schema.Literals(["list", "get", "file_thread", "set_icon"]);
export type ProjectToolOperation = typeof ProjectToolOperation.Type;

export const ProjectToolErrorReason = Schema.Literals([
  "capability_unavailable",
  "not_found",
  "invalid",
  "storage_failed",
]);
export type ProjectToolErrorReason = typeof ProjectToolErrorReason.Type;

export class ProjectToolError extends Schema.TaggedErrorClass<ProjectToolError>()(
  "ProjectToolError",
  {
    operation: ProjectToolOperation,
    reason: ProjectToolErrorReason,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Project ${this.operation} failed: ${this.reason}.${
      this.detail === undefined ? "" : ` ${this.detail}`
    }`;
  }
}

/** One project, as a listing row. */
export const ProjectToolSummary = Schema.Struct({
  slug: ProjectCategorySlug,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  archived: Schema.Boolean,
  /** Folders on this machine filed under the project. */
  boundWorkspaceRoots: Schema.Array(Schema.String),
  /** Threads on this machine the project claims, live ones only. */
  threadCount: Schema.Int,
  /** This machine names an orchestrator for it. */
  hasMaster: Schema.Boolean,
  /**
   * Whether it already has an uploaded icon — the fact, never the bytes.
   *
   * An agent deciding whether to set one needs to know if there is one; it has
   * no use for 24 KB of base64, and putting that in a listing would spend a
   * meaningful slice of the caller's context on a picture it cannot look at.
   */
  hasIcon: Schema.Boolean,
});
export type ProjectToolSummary = typeof ProjectToolSummary.Type;

export const ProjectListInput = Schema.Struct({
  includeArchived: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include archived projects. Defaults to excluding them.",
    }),
  ),
});
export type ProjectListInput = typeof ProjectListInput.Type;

export const ProjectListResult = Schema.Struct({ projects: Schema.Array(ProjectToolSummary) });
export type ProjectListResult = typeof ProjectListResult.Type;

export const ProjectGetInput = Schema.Struct({
  slug: ProjectCategorySlug.annotate({
    description: "Project slug, as returned by project_list.",
  }),
});
export type ProjectGetInput = typeof ProjectGetInput.Type;

/** A thread the project claims, with enough state to decide whether to touch it. */
export const ProjectToolThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  /** Waiting on a human: an approval or a question. */
  needsAttention: Schema.Boolean,
  settled: Schema.Boolean,
  updatedAt: Schema.String,
});
export type ProjectToolThread = typeof ProjectToolThread.Type;

export const ProjectToolLocation = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
});
export type ProjectToolLocation = typeof ProjectToolLocation.Type;

/**
 * Where this machine physically is.
 *
 * The orchestrator's job runs across four checkouts on four hosts, and every
 * path in `locations` above is a path *somewhere*. Without saying where, a
 * planner reading this cannot tell a folder it can look at from one it cannot,
 * and the honest way to close that gap is to say which host, not to move files
 * (invariant 8) or to have starcode run commands on the operator's behalf.
 *
 * **What this is not.** It carries no credential, no port, no user, and no
 * connection string, and nothing in starcode uses it to reach anywhere. It is a
 * name the operator's own SSH config may or may not already know. Observation
 * is the operator's tooling doing what it always could; work is still
 * dispatched as threads, through `peer_thread_create`.
 *
 * `hostname` is null on a machine that could not report one, which is a fact
 * worth stating rather than a value worth inventing.
 */
export const ProjectToolMachine = Schema.Struct({
  environmentId: EnvironmentId,
  /** The connection's display name, as the operator sees it in the sidebar. */
  label: TrimmedNonEmptyString,
  /** The host's own name. What `ssh <host>` would take, if it is configured. */
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  platform: ExecutionEnvironmentPlatform,
});
export type ProjectToolMachine = typeof ProjectToolMachine.Type;

/** What the sky says this project is building, for the features bound to its threads. */
export const ProjectToolFeature = Schema.Struct({
  featureId: Schema.String,
  name: Schema.String,
  stage: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  planned: Schema.Boolean,
});
export type ProjectToolFeature = typeof ProjectToolFeature.Type;

export const ProjectGetResult = Schema.Struct({
  project: ProjectToolSummary,
  /** Operator-authored. The reason this tool exists: it is what the human wrote. */
  notes: Schema.String,
  links: Schema.Array(ProjectCategoryLink),
  /** The machine every path and id below belongs to. */
  machine: ProjectToolMachine,
  locations: Schema.Array(ProjectToolLocation),
  threads: Schema.Array(ProjectToolThread),
  features: Schema.Array(ProjectToolFeature),
  masterThreadId: Schema.NullOr(ThreadId),
});
export type ProjectGetResult = typeof ProjectGetResult.Type;

export const ProjectFileThreadToolInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description:
        "Thread to file. Defaults to the calling thread. Filing another thread requires the orchestrator capability.",
    }),
  ),
  slug: Schema.optional(
    ProjectCategorySlug.annotate({
      description:
        "Project to file it under. Omit together with mode=unfile to let the folder decide again.",
    }),
  ),
  mode: Schema.optional(
    ProjectCatalogFileThreadMode.annotate({
      description:
        "assign files the thread, exclude keeps it out of a project its folder would put it in, unfile drops both opinions. Defaults to assign.",
    }),
  ),
});
export type ProjectFileThreadToolInput = typeof ProjectFileThreadToolInput.Type;

export const ProjectFileThreadToolResult = Schema.Struct({
  threadId: ThreadId,
  /** Where the thread ended up, or null when nothing claims it now. */
  slug: Schema.NullOr(ProjectCategorySlug),
  mode: ProjectCatalogFileThreadMode,
});
export type ProjectFileThreadToolResult = typeof ProjectFileThreadToolResult.Type;

/**
 * Setting a project's icon from a thread.
 *
 * The gate mirrors `project_file_thread` exactly, and for the same reason: a
 * thread acting on *its own* project is that thread's business, and acting on
 * somebody else's is an orchestrator's. Doing this any other way would mean
 * either taking a small, obviously-useful write away from every worker or
 * letting any session restyle a project it has never touched, on four machines.
 */
export const ProjectSetIconToolInput = Schema.Struct({
  slug: Schema.optional(
    ProjectCategorySlug.annotate({
      description:
        "Project to set the icon on. Defaults to the project the calling thread is filed under. Setting any other project's icon requires the orchestrator capability.",
    }),
  ),
  icon: ProjectCategoryIconDataUri.annotate({
    description:
      "The icon as a base64 data URI (data:image/webp;base64,…). png, webp, jpeg and gif are accepted; svg is not. It is shown at ~16-28px beside the project name, so encode it small — square, about 96px, under 32000 characters encoded. Pass an empty string to clear it and go back to the derived constellation.",
  }),
});
export type ProjectSetIconToolInput = typeof ProjectSetIconToolInput.Type;

export const ProjectSetIconToolResult = Schema.Struct({
  slug: ProjectCategorySlug,
  /** False when the call cleared the icon. The bytes never come back. */
  hasIcon: Schema.Boolean,
  /** Characters stored, so a caller can see what its encoding actually cost. */
  iconLength: Schema.Int,
  /** The stamp this machine wrote, which is what the fold sorts on. */
  updatedAt: IsoDateTime,
});
export type ProjectSetIconToolResult = typeof ProjectSetIconToolResult.Type;
