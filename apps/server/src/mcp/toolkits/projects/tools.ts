/**
 * The project tools: what an agent can ask about the work it is inside of.
 *
 * Michael's ask for F16 was that projects exist "for threads to be organized
 * through the tool calls", and this file is the half of that sentence a server
 * has to own. A client-side grouping could never answer it: an agent calling
 * `project_get` needs a surface that exists on the machine it is running on.
 *
 * Project management is open to every authenticated provider session. The
 * user's intent is that agents can organize the fleet rather than merely read
 * an operator-authored grouping, so creation, metadata, binding, filing, and
 * physical StarCode project lifecycle all use the same base `threads` grant.
 *
 * **Where things physically are, and what starcode does about it.** An
 * orchestrator's project spans four checkouts on four hosts, and it needs to
 * see the state of all of them — including the uncommitted state no push has
 * carried anywhere. `project_get` answers that by naming the machine and its
 * hostname beside the paths, and stops there: the operator's own SSH config is
 * how a planner goes and looks, and it is theirs, not ours to hold. Nothing
 * here stores or transmits a credential. Fleet-targeted tools use credentials
 * held by the server and return only public node names. The alternative, a
 * synced filesystem, is still refused: a project is mutual awareness, not
 * mutual state.
 *
 * @module ProjectTools
 */
import {
  ProjectFileThreadToolInput,
  ProjectFileThreadToolResult,
  ProjectBindLocationToolInput,
  ProjectBindLocationToolResult,
  ProjectGetInput,
  ProjectGetResult,
  ProjectLocationCreateToolInput,
  ProjectLocationCreateToolResult,
  ProjectLocationRemoveToolInput,
  ProjectLocationRemoveToolResult,
  ProjectLocationsToolInput,
  ProjectLocationsToolResult,
  ProjectLocationUpdateToolInput,
  ProjectLocationUpdateToolResult,
  ProjectListInput,
  ProjectListResult,
  ProjectRemoveToolInput,
  ProjectRemoveToolResult,
  ProjectSetIconToolInput,
  ProjectSetIconToolResult,
  ProjectToolError,
  ProjectUpsertToolInput,
  ProjectUpsertToolResult,
} from "@starcode/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { FeatureMapRegistry } from "../../../featureMap/FeatureMapRegistry.ts";
import { FleetRegistry } from "../../../fleet/FleetRegistry.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Declared on every tool rather than per tool, so the toolkit's context is one
 * fact. A project is a category joined against the projection (which threads,
 * which folders) and against the feature map (what they are building) — none of
 * the three answers anything on its own.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectCatalogRegistry,
  ProjectionSnapshotQuery,
  FeatureMapRegistry,
  // Which host all of the above is on. Named, never dialled.
  ServerEnvironment.ServerEnvironment,
  FleetRegistry,
  OrchestrationEngineService,
  HttpClient.HttpClient,
  Crypto.Crypto,
];

const readTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

const writeTool = <T extends Tool.Any>(tool: T, destructive = false): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, destructive)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true) as T;

export const ProjectListTool = readTool(
  Tool.make("project_list", {
    description:
      "List logical projects on the current or named fleet connection. Each row carries the slug, bound folders, live-thread count, and whether an orchestrator is designated. Call this before project_get or filing a thread so you use a slug that exists on that connection.",
    parameters: ProjectListInput,
    success: ProjectListResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "List projects"),
);

export const ProjectGetTool = readTool(
  Tool.make("project_get", {
    description:
      "Read one logical project in full on the current or named fleet connection: notes, links, machine identity, bound folders, threads, features, and orchestrator. Use the node parameter to inspect another connection without creating a thread there.",
    parameters: ProjectGetInput,
    success: ProjectGetResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "Read a project"),
);

/**
 * Not open-world (it writes one local file) but not idempotent either: filing a
 * thread retracts every other claim on it, so the same call made twice in
 * different orders does not commute with a call in between.
 */
export const ProjectFileThreadTool = Tool.make("project_file_thread", {
  description:
    "File any thread under a logical project on the current or named fleet connection. Omit threadId only for your own thread on the current connection. mode=assign files it, mode=exclude keeps it out of a project its folder would otherwise select, and mode=unfile drops both opinions so the folder decides again.",
  parameters: ProjectFileThreadToolInput,
  success: ProjectFileThreadToolResult,
  failure: ProjectToolError,
  dependencies,
})
  .annotate(Tool.Title, "File a thread under a project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

/**
 * The first *display* write any tool in this fork makes, which is worth naming.
 *
 * Every other project tool answers about this machine and changes nothing that
 * leaves it. An icon is display: the fold resolves display halves on newest
 * `updatedAt`, so an icon set here becomes the icon the operator sees on every
 * surface on every machine as soon as any client folds the catalog — and the
 * other machines' own copies catch up the next time a display write fans out.
 * That is the replication story working as designed, not a gap: one machine
 * authored an opinion about what the project *is*, and that is precisely the
 * half of a record that is allowed to travel.
 *
 * Available to every authenticated task, like the rest of project management.
 */
export const ProjectSetIconTool = Tool.make("project_set_icon", {
  description:
    "Set the icon shown beside any logical project's name on the current or named fleet connection. Omit slug only for your own project on the current connection. Accepts png, webp, jpeg and gif, not svg, and refuses anything over 32000 characters encoded; shrink it to about 96px square. Pass an empty icon to clear it.",
  parameters: ProjectSetIconToolInput,
  success: ProjectSetIconToolResult,
  failure: ProjectToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set a project's icon")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  // Setting the same icon twice lands the same record; only the stamp moves.
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectLocationsTool = readTool(
  Tool.make("project_locations", {
    description:
      "List every physical StarCode project folder on a fleet connection, including folders not yet bound to a logical project. Use this before binding, renaming, reconfiguring, or removing a physical project.",
    parameters: ProjectLocationsToolInput,
    success: ProjectLocationsToolResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "List project folders"),
);

export const ProjectUpsertTool = writeTool(
  Tool.make("project_upsert", {
    description:
      "Create or patch a logical project on a chosen fleet connection. Display fields manage title, summary, notes, links, icon, and archive state; local fields manage folder bindings, explicitly filed threads, the project master, and defaults. Omitted fields are preserved. Slugs are stable identifiers and are not renamed—create the new slug, move bindings, then remove the old one.",
    parameters: ProjectUpsertToolInput,
    success: ProjectUpsertToolResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "Create or update a project"),
);

export const ProjectRemoveTool = writeTool(
  Tool.make("project_remove", {
    description:
      "Remove a logical project category from a chosen connection. This does not delete physical folders, source files, or physical project records. Repeat on each desired connection when removing a fleet-wide category.",
    parameters: ProjectRemoveToolInput,
    success: ProjectRemoveToolResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "Remove a logical project"),
  true,
);

export const ProjectBindLocationTool = writeTool(
  Tool.make("project_bind_location", {
    description:
      "Bind or unbind one physical project folder to a logical project on a chosen connection without replacing its other bindings. It can also make the folder the preferred placement for new threads.",
    parameters: ProjectBindLocationToolInput,
    success: ProjectBindLocationToolResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "Bind a project folder"),
);

export const ProjectLocationCreateTool = writeTool(
  Tool.make("project_location_create", {
    description:
      "Create a physical StarCode project record on a chosen fleet connection and optionally bind it to a logical project. The workspace path is interpreted on the target connection; the folder is created only when createWorkspaceRootIfMissing=true.",
    parameters: ProjectLocationCreateToolInput,
    success: ProjectLocationCreateToolResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "Create a project folder"),
);

export const ProjectLocationUpdateTool = writeTool(
  Tool.make("project_location_update", {
    description:
      "Rename, move, change the default model, or replace scripts for a physical project record on a chosen fleet connection. At least one patch field is required.",
    parameters: ProjectLocationUpdateToolInput,
    success: ProjectLocationUpdateToolResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "Update a project folder"),
);

export const ProjectLocationRemoveTool = writeTool(
  Tool.make("project_location_remove", {
    description:
      "Remove a physical project record from a chosen fleet connection. force=true also removes its StarCode thread records. The workspace folder and source files are never deleted.",
    parameters: ProjectLocationRemoveToolInput,
    success: ProjectLocationRemoveToolResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "Remove a project folder"),
  true,
);

export const ProjectsToolkit = Toolkit.make(
  ProjectListTool,
  ProjectGetTool,
  ProjectFileThreadTool,
  ProjectSetIconTool,
  ProjectLocationsTool,
  ProjectUpsertTool,
  ProjectRemoveTool,
  ProjectBindLocationTool,
  ProjectLocationCreateTool,
  ProjectLocationUpdateTool,
  ProjectLocationRemoveTool,
);
