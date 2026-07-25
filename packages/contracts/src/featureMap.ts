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
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { FeatureFlowStage } from "./featureFlow.ts";

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
 * Replaces the whole planned overlay in one call.
 *
 * Replace rather than merge because a plan is a shape, not a pile of rows: a
 * second plan that drops a step means the step is gone, and a merging tool
 * would leave it on the sky forever with no way for the author to notice. Real
 * features are never touched by this call.
 */
export const FeaturePlanSetInput = Schema.Struct({
  features: Schema.Array(FeaturePlanEntry),
});
export type FeaturePlanSetInput = typeof FeaturePlanSetInput.Type;

export const FeaturePlanSetResult = Schema.Struct({
  entries: Schema.Array(FeatureMapEntry),
  /** Planned entries this call removed, so the tool result is auditable. */
  removedCount: Schema.Number,
});
export type FeaturePlanSetResult = typeof FeaturePlanSetResult.Type;
