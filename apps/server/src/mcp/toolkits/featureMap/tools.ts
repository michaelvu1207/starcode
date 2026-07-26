/**
 * The orchestrator's tools for working the sky directly.
 *
 * Reading the map is open to every session — an agent that knows which feature
 * it is working on writes better commits and asks better questions. Writing it
 * is the master's alone, for the same reason `peer_thread_create` is: a shared
 * account of what is being built stops being useful the moment several agents
 * are editing it from different turns with no idea of each other's intent.
 *
 * @module FeatureMapTools
 */
import {
  FeatureCreateInput,
  FeatureLinkInput,
  FeatureMapEntryResult,
  FeatureMapError,
  FeatureMapListInput,
  FeatureMapListResult,
  FeaturePlanSetInput,
  FeaturePlanSetResult,
  FeaturePromoteInput,
  FeatureUpdateInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import { FeatureMapRegistry } from "../../../featureMap/FeatureMapRegistry.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * The catalog and the projection are here for one reason: `feature_map_list`
 * takes a project slug, and an *unfiled* feature belongs to whatever project
 * its thread does. Resolving that needs this machine's membership, and the
 * doctrine allows exactly one resolver per scope — so this reads
 * `resolveLocalProjectMembership` rather than growing a second rule that keys
 * features to projects on its own.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  FeatureMapRegistry,
  ProjectCatalogRegistry,
  ProjectionSnapshotQuery,
];

const readTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

/**
 * Writes are local to this machine's registry, so none of them are open-world.
 * Only `feature_plan_set` is destructive, and honestly so: it replaces the
 * whole planned overlay, which is the one call here that can remove something
 * the caller did not name.
 */
const writeTool = <T extends Tool.Any>(tool: T, destructive: boolean): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, destructive)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false) as T;

export const FeatureMapListTool = readTool(
  Tool.make("feature_map_list", {
    description:
      "List the features on the workbench sky: name, description, the project each is filed under, the stage each has reached (in-progress, in-dev, in-staging, in-production), the thread doing the work, and which features wait on which. Planned features — ones that exist only as intent — are included and marked. Pass slug to see one project's features only. Answers about this machine's registry; other machines keep their own. Use this before creating a feature, so you enrich the existing entry instead of adding a duplicate.",
    parameters: FeatureMapListInput,
    success: FeatureMapListResult,
    failure: FeatureMapError,
    dependencies,
  }).annotate(Tool.Title, "List features"),
);

export const FeatureCreateTool = writeTool(
  Tool.make("feature_create", {
    description:
      "Add a feature to the sky. Pass threadId to bind it to work already running, which is what makes the star clickable; omit it for work not started yet. Pass slug to file it under a project — required if you want a feature with no thread to appear on that project's home, since a planned feature has no thread to inherit a project from. Pass planned=true for a feature that is intended rather than under way — it renders as a ghost until a thread is bound to it. Stage defaults to in-progress.",
    parameters: FeatureCreateInput,
    success: FeatureMapEntryResult,
    failure: FeatureMapError,
    dependencies,
  }).annotate(Tool.Title, "Create a feature"),
  false,
);

export const FeatureUpdateTool = writeTool(
  Tool.make("feature_update", {
    description:
      "Rename a feature, change its description, file it under a project, or bind it to a thread. Binding a thread turns a planned feature into real work automatically — pass planned explicitly only if you mean to override that. Pass slug=null to unfile it, after which it belongs to whatever project its thread does.",
    parameters: FeatureUpdateInput,
    success: FeatureMapEntryResult,
    failure: FeatureMapError,
    dependencies,
  }).annotate(Tool.Title, "Update a feature"),
  false,
);

export const FeaturePromoteTool = writeTool(
  Tool.make("feature_promote", {
    description:
      "Move a feature up the chain: in-progress to in-dev, in-dev to in-staging, in-staging to in-production. Omit stage to advance one step, or pass one to set it outright. This overrides what the repository would report on its own, so promote when the work has actually moved, not when you expect it to.",
    parameters: FeaturePromoteInput,
    success: FeatureMapEntryResult,
    failure: FeatureMapError,
    dependencies,
  }).annotate(Tool.Title, "Promote a feature"),
  false,
);

export const FeatureLinkTool = writeTool(
  Tool.make("feature_link", {
    description:
      "Record that one feature waits on another, so the sky draws it branching from that feature instead of from the shared start. Pass linked=false to remove the link. A link that would make two features wait on each other is refused.",
    parameters: FeatureLinkInput,
    success: FeatureMapEntryResult,
    failure: FeatureMapError,
    dependencies,
  }).annotate(Tool.Title, "Link two features"),
  false,
);

export const FeaturePlanSetTool = writeTool(
  Tool.make("feature_plan_set", {
    description:
      "Lay out an intended shape of work on the sky as planned (ghost) features, replacing any previous plan. Features under way are never touched. Each entry carries a caller-local key, and dependsOn refers to those keys, so a whole branching plan is expressed in one call. Call it with an empty list to clear the plan. Pass slug if you orchestrate one project: the replacement is then scoped to that project's plan and the new features are filed under it. Without a slug this replaces every planned feature on this machine, including other projects'.",
    parameters: FeaturePlanSetInput,
    success: FeaturePlanSetResult,
    failure: FeatureMapError,
    dependencies,
  }).annotate(Tool.Title, "Set the planned flow"),
  true,
);

export const FeatureMapToolkit = Toolkit.make(
  FeatureMapListTool,
  FeatureCreateTool,
  FeatureUpdateTool,
  FeaturePromoteTool,
  FeatureLinkTool,
  FeaturePlanSetTool,
);
