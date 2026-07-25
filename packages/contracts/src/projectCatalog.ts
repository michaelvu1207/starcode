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

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { WorkbenchMasterDefaults } from "./settings.ts";

export const PROJECT_CATEGORY_SLUG_MAX_LENGTH = 64;
export const PROJECT_CATEGORY_TITLE_MAX_LENGTH = 200;
export const PROJECT_CATEGORY_SUMMARY_MAX_LENGTH = 500;
export const PROJECT_CATEGORY_NOTES_MAX_LENGTH = 16_000;
export const PROJECT_CATEGORY_LINK_MAX_COUNT = 32;

/**
 * The identity, and the join key across machines.
 *
 * Immutable after creation — there is no rename-slug operation anywhere in this
 * contract, and renaming a category changes `display.title` only. That is what
 * makes name drift harmless: two machines can disagree about the title of a
 * category and still agree that it is the same category.
 */
export const ProjectCategorySlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_CATEGORY_SLUG_MAX_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("ProjectCategorySlug"));
export type ProjectCategorySlug = typeof ProjectCategorySlug.Type;

/**
 * Turns arbitrary text into a slug, or `null` when nothing survives.
 *
 * Lives in contracts rather than in either the server or the client because
 * both seed categories — the client from repository identity, the MCP tools
 * from a name an agent supplied — and two implementations of this would file
 * the same repository under two slugs.
 */
export function toProjectCategorySlug(input: string): ProjectCategorySlug | null {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_CATEGORY_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug.length === 0 ? null : (slug as ProjectCategorySlug);
}

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
