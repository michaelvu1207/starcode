/**
 * The project tools: what an agent can ask about the work it is inside of.
 *
 * Michael's ask for F16 was that projects exist "for threads to be organized
 * through the tool calls", and this file is the half of that sentence a server
 * has to own. A client-side grouping could never answer it: an agent calling
 * `project_get` needs a surface that exists on the machine it is running on.
 *
 * The split follows the one `feature_map_list` and `peer_thread_send` already
 * established. Reading is open to every session, because an agent that knows
 * which project it is in — and can read the notes a human wrote about it —
 * orients better and asks better questions. Writing is narrower, but not
 * master-only: filing *yourself* is the one write every worker should have,
 * since a thread knowing where it belongs is the thread's own business. Filing
 * someone else is an orchestrator's act and is gated accordingly.
 *
 * That is why `project_file_thread` is deliberately absent from
 * `CAPABILITY_GATED_TOOLS`: hiding it would take self-filing away from every
 * worker to gate a use most of them will never reach for, which is exactly the
 * mistake that list's own comment warns about for `peer_thread_send`.
 *
 * **Where things physically are, and what starcode does about it.** An
 * orchestrator's project spans four checkouts on four hosts, and it needs to
 * see the state of all of them — including the uncommitted state no push has
 * carried anywhere. `project_get` answers that by naming the machine and its
 * hostname beside the paths, and stops there: the operator's own SSH config is
 * how a planner goes and looks, and it is theirs, not ours to hold. Nothing
 * here stores or transmits a credential, and there is no tool that runs a
 * command somewhere else — observation is a read the planner performs with its
 * own tooling, and *work* is dispatched as threads through
 * `peer_thread_create`. The alternative, a synced filesystem, is refused by
 * doctrine (invariant 8): a project is mutual awareness, not mutual state.
 *
 * @module ProjectTools
 */
import {
  ProjectFileThreadToolInput,
  ProjectFileThreadToolResult,
  ProjectGetInput,
  ProjectGetResult,
  ProjectListInput,
  ProjectListResult,
  ProjectSetIconToolInput,
  ProjectSetIconToolResult,
  ProjectToolError,
} from "@starcode/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { FeatureMapRegistry } from "../../../featureMap/FeatureMapRegistry.ts";
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
];

const readTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

export const ProjectListTool = readTool(
  Tool.make("project_list", {
    description:
      "List the projects on this machine: the cross-machine categories threads are organized under, not the folders themselves. Each row carries the slug to address it by, the folders bound to it here, how many live threads it holds, and whether an orchestrator is designated. Call this before project_get, and before filing a thread, so you use a slug that exists.",
    parameters: ProjectListInput,
    success: ProjectListResult,
    failure: ProjectToolError,
    dependencies,
  }).annotate(Tool.Title, "List projects"),
);

export const ProjectGetTool = readTool(
  Tool.make("project_get", {
    description:
      "Read one project in full: the notes and links a human wrote about it, the machine answering and its hostname, the folders bound to it there, its threads with whether each is waiting on a person, the features it has on the workbench sky, and its orchestrator. Use it when you have been asked to work on something and want to know what the project actually is before starting. Everything it returns describes this one machine — the same project has its own folders, threads and features on every other connection, and reading those means asking them.",
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
    "File a thread under a project. Omit threadId to file yourself, which is what a worker should do when it learns which project it is working in. mode=assign files it, mode=exclude keeps it out of a project its folder would otherwise put it in, and mode=unfile drops both opinions so the folder decides again. Filing a thread other than your own requires the orchestrator capability.",
  parameters: ProjectFileThreadToolInput,
  success: ProjectFileThreadToolResult,
  failure: ProjectToolError,
  dependencies,
})
  .annotate(Tool.Title, "File a thread under a project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

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
 * Gated the same way `project_file_thread` is, rather than added to
 * `CAPABILITY_GATED_TOOLS`: a thread setting the icon of the project it is
 * working in is doing its own housekeeping, and hiding the tool outright would
 * take that from every worker to prevent a use the handler can simply refuse.
 */
export const ProjectSetIconTool = Tool.make("project_set_icon", {
  description:
    "Set the icon shown beside a project's name on every surface, as a base64 data URI. Omit slug to set your own project's icon — the one your thread is filed under — which needs no special capability; naming any other project requires the orchestrator capability. Accepts png, webp, jpeg and gif, not svg, and refuses anything over 32000 characters encoded, so shrink the image to about 96px square before encoding it: it is drawn at 16-28px and the string is stored in the project record on every machine. Pass an empty icon to clear it and go back to the derived constellation.",
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
  .annotate(Tool.OpenWorld, false);

export const ProjectsToolkit = Toolkit.make(
  ProjectListTool,
  ProjectGetTool,
  ProjectFileThreadTool,
  ProjectSetIconTool,
);
