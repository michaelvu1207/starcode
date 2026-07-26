/**
 * The feature map — the orchestrator's own account of what is being built.
 *
 * Feature *flow* (see `featureFlow.ts`) is derived: it asks git where each
 * thread's work has reached and reports the answer. It is accurate and it is
 * mute — it can say that work exists and where it sits, but it cannot say what
 * the work is *for*, which pieces belong to one effort, or what the plan was.
 *
 * This module is the other half: entries the master thread authors through its
 * MCP tools. A entry may point at a thread, in which case it enriches the
 * derived feature of the same id; it may point at nothing, in which case it is
 * a feature that exists only as intent. Reconciliation is by thread id, and
 * where both sides speak, the master's account wins — it was written by
 * something that knows why, and git only knows what.
 *
 * **No git vocabulary crosses this boundary.** A feature has a name, a
 * description, a stage, the features it waits on, and whether it is real yet.
 * Branches, worktrees and pull requests exist upstream of the stage
 * computation and stop there.
 *
 * @module FeatureMap
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { FeatureFlowStage } from "./featureFlow.ts";
// From the leaf module rather than from `projectCatalog.ts`: this file is
// reached from `featureFlow.ts` → `peers.ts`, and importing the big module
// would close a schema cycle that fails at module-evaluation time rather than
// at build time. See `projectCategorySlug.ts` for the full argument.
import { ProjectCategorySlug } from "./projectCategorySlug.ts";

/**
 * A feature's identity in the map.
 *
 * Minted by the server, not by the caller: an agent that picks its own ids
 * eventually picks one that collides with an entry it cannot see, and the
 * failure — two efforts quietly merged into one — is invisible from inside the
 * tool call that caused it.
 */
export const FeatureMapEntryId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{12}$/),
).pipe(Schema.brand("FeatureMapEntryId"));
export type FeatureMapEntryId = typeof FeatureMapEntryId.Type;

/**
 * One feature, as the orchestrator understands it.
 *
 * `planned` is the whole of the difference between intent and reality. A
 * planned entry is the shape of work that has not started: it renders as a
 * ghost beside the lit stars of real work, and it becomes real by being linked
 * to a thread, not by being edited.
 */
export const FeatureMapEntry = Schema.Struct({
  id: FeatureMapEntryId,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The thread doing this work, when there is one. Null for a planned feature,
   * and for a feature whose thread has not been started yet.
   */
  threadId: Schema.NullOr(ThreadId),
  /**
   * The project this feature belongs to, by slug.
   *
   * The one identifier on this record that means the same thing on every
   * machine, and the only way a *planned* feature can belong to a project at
   * all: a planned entry has `threadId: null`, so a membership rule that keys
   * on threads cannot reach it. Null means "not filed", and a null entry with a
   * thread still resolves through that thread's project — see
   * `featureMapEntryInProject`.
   *
   * Deliberately not derived at write time from the bound thread's project.
   * A stored answer would be a snapshot that goes stale the moment the thread
   * is refiled; the fallback resolves live and stays right.
   *
   * Nullable with a decoding default because this field is additive: registry
   * files written before it existed have no key, and a server one build behind
   * will not send one.
   */
  slug: Schema.NullOr(ProjectCategorySlug).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * The stage the orchestrator says this feature has reached.
   *
   * For a feature bound to a thread this *overrides* the derived stage. That
   * is deliberate and it is the point of the tool: promotion is an act, and an
   * act the operator's agent performed should not be silently overruled by a
   * containment check that has not caught up yet. The cost is that a wrong
   * promotion stays wrong until someone corrects it, which is the normal cost
   * of letting an agent assert things.
   */
  stage: FeatureFlowStage,
  /** Features this one waits on, by map id. Cycles are refused at write time. */
  dependsOn: Schema.Array(FeatureMapEntryId),
  planned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FeatureMapEntry = typeof FeatureMapEntry.Type;

export const FeatureMapSnapshot = Schema.Struct({
  computedAt: IsoDateTime,
  entries: Schema.Array(FeatureMapEntry),
});
export type FeatureMapSnapshot = typeof FeatureMapSnapshot.Type;

/**
 * Whether a feature belongs to a project.
 *
 * Lives in contracts, beside the record it reads, because two callers need the
 * same answer and a second implementation would eventually give a different
 * one: the server's `project_get` scopes its own registry with it, and the
 * client's sky scopes every machine's registry with it. That is the same
 * argument `resolveLocalProjectMembership` makes one file over.
 *
 * Two clauses, and the order between them is the rule:
 *
 * 1. **A filed feature is filed.** A non-null `slug` is the orchestrator saying
 *    which project this is, and it outranks wherever its thread happens to
 *    sit — a thread can be refiled without that meaning the feature moved.
 * 2. **An unfiled feature inherits its thread's project.** Which is what keeps
 *    every entry written before this field existed on the right sky, and what
 *    makes filing optional rather than a migration.
 *
 * An unfiled feature with no thread belongs to no project. It is on the fleet
 * sky and nowhere else, which is the honest answer: nothing has said where it
 * goes.
 *
 * `threadInProject` is a predicate rather than a set so the caller decides what
 * "this project's threads" means in its own scope — thread ids on one machine
 * for the server, `environmentId:threadId` keys across the fleet for the client.
 */
export function featureMapEntryInProject(
  entry: {
    readonly slug: ProjectCategorySlug | null;
    readonly threadId: ThreadId | null;
  },
  slug: ProjectCategorySlug,
  threadInProject: (threadId: ThreadId) => boolean,
): boolean {
  if (entry.slug !== null) return entry.slug === slug;
  return entry.threadId !== null && threadInProject(entry.threadId);
}

// ── Tool surfaces ───────────────────────────────────────────────────

export const FeatureMapOperation = Schema.Literals([
  "list",
  "create",
  "update",
  "promote",
  "link",
  "plan_set",
]);
export type FeatureMapOperation = typeof FeatureMapOperation.Type;

export const FeatureMapErrorReason = Schema.Literals([
  "capability_unavailable",
  "not_found",
  "cycle",
  "invalid",
  "storage_failed",
]);
export type FeatureMapErrorReason = typeof FeatureMapErrorReason.Type;

export class FeatureMapError extends Schema.TaggedErrorClass<FeatureMapError>()("FeatureMapError", {
  operation: FeatureMapOperation,
  reason: FeatureMapErrorReason,
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `Feature map ${this.operation} failed: ${this.reason}.${
      this.detail === undefined ? "" : ` ${this.detail}`
    }`;
  }
}

export const FeatureMapListInput = Schema.Struct({
  /** Include features that exist only as intent. Defaults to including them. */
  includePlanned: Schema.optional(Schema.Boolean),
  /**
   * Only features belonging to this project. Omit for everything this machine
   * holds. Resolved by `featureMapEntryInProject`, so an unfiled feature whose
   * thread sits in the project is included.
   */
  slug: Schema.optional(ProjectCategorySlug),
});
export type FeatureMapListInput = typeof FeatureMapListInput.Type;

export const FeatureMapListResult = Schema.Struct({
  entries: Schema.Array(FeatureMapEntry),
});
export type FeatureMapListResult = typeof FeatureMapListResult.Type;

export const FeatureCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  /** Bind the feature to work already running. Omit for a feature not started. */
  threadId: Schema.optional(ThreadId),
  /** File it under a project. Omit to let a bound thread's project answer. */
  slug: Schema.optional(ProjectCategorySlug),
  stage: Schema.optional(FeatureFlowStage),
  dependsOn: Schema.optional(Schema.Array(FeatureMapEntryId)),
  /** True for a feature that is intended rather than under way. */
  planned: Schema.optional(Schema.Boolean),
});
export type FeatureCreateInput = typeof FeatureCreateInput.Type;

export const FeatureMapEntryResult = Schema.Struct({
  entry: FeatureMapEntry,
});
export type FeatureMapEntryResult = typeof FeatureMapEntryResult.Type;

export const FeatureUpdateInput = Schema.Struct({
  id: FeatureMapEntryId,
  name: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * Binding a thread is how a planned feature becomes real, so passing one
   * clears `planned` unless the call says otherwise.
   */
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  /** File it, or pass null to unfile it and let its thread answer again. */
  slug: Schema.optional(Schema.NullOr(ProjectCategorySlug)),
  planned: Schema.optional(Schema.Boolean),
});
export type FeatureUpdateInput = typeof FeatureUpdateInput.Type;

export const FeaturePromoteInput = Schema.Struct({
  id: FeatureMapEntryId,
  /** Omit to advance one step; pass a stage to set it outright. */
  stage: Schema.optional(FeatureFlowStage),
});
export type FeaturePromoteInput = typeof FeaturePromoteInput.Type;

export const FeatureLinkInput = Schema.Struct({
  id: FeatureMapEntryId,
  dependsOnId: FeatureMapEntryId,
  /** Pass false to remove the link instead of adding it. */
  linked: Schema.optional(Schema.Boolean),
});
export type FeatureLinkInput = typeof FeatureLinkInput.Type;

/**
 * One planned feature, as laid out by a plan. Ids are optional so a plan can
 * be written before anything exists; `dependsOn` refers to the `key` of another
 * entry in the same call, which is what lets an intended shape be expressed in
 * a single write.
 */
export const FeaturePlanEntry = Schema.Struct({
  /** Caller-local handle, used only to wire `dependsOn` inside this call. */
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  stage: Schema.optional(FeatureFlowStage),
  dependsOn: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type FeaturePlanEntry = typeof FeaturePlanEntry.Type;

/**
 * Replaces the planned overlay in one call.
 *
 * Replace rather than merge because a plan is a shape, not a pile of rows: a
 * second plan that drops a step means the step is gone, and a merging tool
 * would leave it on the sky forever with no way for the author to notice. Real
 * features are never touched by this call.
 *
 * **What `slug` scopes, and why it is not cosmetic.** The doctrine's rule is one
 * project, one workbench, one orchestrator — so a machine can carry several
 * project masters, all planning into the same registry. Without a scope, the
 * second master's plan silently deletes the first's, and neither agent can see
 * it happen from inside the call that caused it. With a slug, the replacement
 * covers exactly that project's planned entries and the new ones are filed
 * under it.
 *
 * Omitting the slug keeps the original meaning — replace *every* planned entry,
 * filed or not — because that is what the tool has always promised and a
 * quietly narrowed destructive call is worse than a wide one. A project master
 * should always pass its slug.
 */
export const FeaturePlanSetInput = Schema.Struct({
  features: Schema.Array(FeaturePlanEntry),
  slug: Schema.optional(ProjectCategorySlug),
});
export type FeaturePlanSetInput = typeof FeaturePlanSetInput.Type;

export const FeaturePlanSetResult = Schema.Struct({
  entries: Schema.Array(FeatureMapEntry),
  /** Planned entries this call removed, so the tool result is auditable. */
  removedCount: Schema.Number,
});
export type FeaturePlanSetResult = typeof FeaturePlanSetResult.Type;
