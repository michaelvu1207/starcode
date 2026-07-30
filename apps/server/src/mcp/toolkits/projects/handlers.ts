/**
 * Handlers for the project tools.
 *
 * Everything here answers about *this* machine. That is not a limitation to
 * apologise for — it is the same split the registry itself is built on: a
 * category's display half is everyone's, its membership is the authoring
 * machine's, and a server that reported another machine's threads would be
 * reporting ids that mean nothing where it is standing.
 *
 * @module ProjectHandlers
 */
import {
  describeProjectCategoryIconRejection,
  featureMapEntryInProject,
  ProjectToolError,
  resolveLocalProjectMembership,
  validateProjectCategoryIcon,
  type ProjectCatalogFileThreadMode,
  type ProjectCategoryRecord,
  type ProjectCategorySlug,
  type ProjectToolFeature,
  type ProjectToolLocation,
  type ProjectToolOperation,
  type ProjectToolSummary,
  type ProjectToolThread,
  type ThreadId,
} from "@starcode/contracts";
import { HostProcessHostname } from "@starcode/shared/hostProcess";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { FeatureMapRegistry } from "../../../featureMap/FeatureMapRegistry.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectsToolkit } from "./tools.ts";

/**
 * Reads are open to every session that can talk to peers at all, which is
 * every session. The check exists so a credential minted without the base
 * capability — a shape that should not occur — fails loudly rather than
 * reading the operator's notes.
 */
const requireRead = (operation: ProjectToolOperation) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("peers")) {
      return yield* new ProjectToolError({
        operation,
        reason: "capability_unavailable",
        detail: "This MCP credential does not grant the projects capability.",
      });
    }
    return invocation;
  });

const storageFailed = (operation: ProjectToolOperation) => (cause: unknown) =>
  new ProjectToolError({
    operation,
    reason: "storage_failed",
    detail: `The project catalog could not be read on this machine. ${String(cause)}`,
  });

/** A thread is this machine's business only while it exists and is not archived. */
const isLiveThread = (thread: { readonly archivedAt: string | null }): boolean =>
  thread.archivedAt === null;

/**
 * Null rather than an empty string for a host that could not name itself: the
 * planner has to be able to tell "this machine is called X" from "this machine
 * did not say", and a blank reads as the first.
 */
const normalizeHostname = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const summarize = (input: {
  readonly category: ProjectCategoryRecord;
  readonly workspaceRootByProjectId: ReadonlyMap<string, string>;
  readonly threadCount: number;
}): ProjectToolSummary => ({
  slug: input.category.slug,
  title: input.category.display.title,
  summary: input.category.display.summary,
  archived: input.category.display.archivedAt !== null,
  boundWorkspaceRoots: input.category.local.bindings
    .map((binding) => input.workspaceRootByProjectId.get(binding.projectId))
    .filter((root): root is string => root !== undefined),
  threadCount: input.threadCount,
  hasMaster: input.category.local.masterThreadId.trim().length > 0,
  // The fact, not the bytes. A listing that carried four data URIs would
  // spend more of the caller's context on pictures than on projects.
  hasIcon: input.category.display.icon.length > 0,
});

/**
 * The catalog, the projection and the feature map, read together.
 *
 * One place rather than per handler because both reads need the same three, and
 * because reading them concurrently is the difference between a tool call an
 * agent waits on and one it does not notice.
 */
const readMachineState = (operation: ProjectToolOperation) =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const [categories, shell] = yield* Effect.all(
      [
        // An unreadable catalog is no projects, not a failed read (invariant
        // 11). Refusing the read instead left an orchestrator on that machine
        // unable to see its project or even file its own thread, over a file
        // it could have been told was unreadable. The write path below still
        // fails loudly, because a write against a catalog nobody could read
        // would overwrite whatever is in it.
        registry.list.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not read the project catalog; reporting no projects", {
              cause,
            }).pipe(Effect.as([])),
          ),
        ),
        projectionSnapshotQuery.getShellSnapshot().pipe(Effect.mapError(storageFailed(operation))),
      ],
      { concurrency: 2 },
    );

    const liveThreads = shell.threads.filter(isLiveThread);
    return {
      categories,
      shell,
      liveThreads,
      workspaceRootByProjectId: new Map(
        shell.projects.map((project) => [project.id, project.workspaceRoot] as const),
      ),
      membership: resolveLocalProjectMembership({
        categories,
        threads: liveThreads.map((thread) => ({ id: thread.id, projectId: thread.projectId })),
      }),
    };
  });

const handlers = {
  project_list: (input) =>
    Effect.gen(function* () {
      yield* requireRead("list");
      const state = yield* readMachineState("list");
      const includeArchived = input.includeArchived ?? false;

      return {
        projects: state.categories
          .filter((category) => includeArchived || category.display.archivedAt === null)
          .map((category) =>
            summarize({
              category,
              workspaceRootByProjectId: state.workspaceRootByProjectId,
              threadCount: (state.membership.get(category.slug) ?? []).length,
            }),
          )
          .toSorted((left, right) => left.slug.localeCompare(right.slug)),
      };
    }),

  project_get: (input) =>
    Effect.gen(function* () {
      yield* requireRead("get");
      const state = yield* readMachineState("get");
      const category = state.categories.find((entry) => entry.slug === input.slug);
      if (category === undefined) {
        return yield* new ProjectToolError({
          operation: "get",
          reason: "not_found",
          detail: `This machine has no project '${input.slug}'. Its projects are: ${
            state.categories.map((entry) => entry.slug).join(", ") || "(none)"
          }.`,
        });
      }

      const threadIds = new Set<string>(state.membership.get(category.slug) ?? []);
      const threads = state.liveThreads
        .filter((thread) => threadIds.has(thread.id))
        .map(
          (thread): ProjectToolThread => ({
            threadId: thread.id,
            title: thread.title,
            workspaceRoot:
              thread.worktreePath ?? state.workspaceRootByProjectId.get(thread.projectId) ?? "",
            // The two ways a thread stops on its own and waits, which is the
            // one fact an orchestrator reading this actually needs.
            needsAttention: thread.hasPendingApprovals || thread.hasPendingUserInput,
            updatedAt: thread.updatedAt,
          }),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

      // The feature map is this machine's own registry, scoped to the project by
      // the one rule both this and the client's sky use. A feature filed under
      // the slug counts even with no thread — which is the only way a *planned*
      // feature can belong to a project at all — and an unfiled one counts when
      // its thread does.
      const featureRegistry = yield* FeatureMapRegistry;
      const entries = yield* featureRegistry.list.pipe(Effect.catchCause(() => Effect.succeed([])));
      const features = entries
        .filter((entry) =>
          featureMapEntryInProject(entry, category.slug, (threadId) => threadIds.has(threadId)),
        )
        .map(
          (entry): ProjectToolFeature => ({
            featureId: entry.id,
            name: entry.name,
            stage: entry.stage,
            threadId: entry.threadId,
            planned: entry.planned,
          }),
        );

      const locations = category.local.bindings
        .map((binding): ProjectToolLocation | null => {
          const project = state.shell.projects.find(
            (candidate) => candidate.id === binding.projectId,
          );
          return project === null || project === undefined
            ? null
            : {
                projectId: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
              };
        })
        .filter((location): location is ProjectToolLocation => location !== null);

      // Which host these paths are on. The orchestrator runs across four
      // checkouts on four machines, and a folder it cannot place is a folder it
      // cannot reason about — but the answer is a name, not a way in. See
      // `ProjectToolMachine` for what this deliberately does not carry.
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const descriptor = yield* environment.getDescriptor;
      const hostname = normalizeHostname(yield* HostProcessHostname);

      const masterThreadId = category.local.masterThreadId.trim();
      return {
        project: summarize({
          category,
          workspaceRootByProjectId: state.workspaceRootByProjectId,
          threadCount: threads.length,
        }),
        notes: category.display.notes,
        links: category.display.links,
        machine: {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          hostname,
          platform: descriptor.platform,
        },
        locations,
        threads,
        features,
        masterThreadId: masterThreadId.length === 0 ? null : (masterThreadId as ThreadId),
      };
    }),

  project_file_thread: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireRead("file_thread");
      const threadId = input.threadId ?? invocation.threadId;
      const mode: ProjectCatalogFileThreadMode = input.mode ?? "assign";

      // The one gate on this tool. Filing yourself is a thread's own business;
      // filing someone else moves another agent's work under a different
      // heading, which is an orchestrator's act.
      if (threadId !== invocation.threadId && !invocation.capabilities.has("peers-operate")) {
        return yield* new ProjectToolError({
          operation: "file_thread",
          reason: "capability_unavailable",
          detail:
            "Only the designated master thread may file a thread other than its own. Call this without threadId to file yourself.",
        });
      }

      // Mirrors `isValidProjectCatalogFileThreadRequest`, in the vocabulary the
      // tool takes: assign and exclude need a project, unfile names none.
      if (mode === "unfile") {
        if (input.slug !== undefined) {
          return yield* new ProjectToolError({
            operation: "file_thread",
            reason: "invalid",
            detail: "unfile drops every opinion about the thread, so it takes no slug.",
          });
        }
      } else if (input.slug === undefined) {
        return yield* new ProjectToolError({
          operation: "file_thread",
          reason: "invalid",
          detail: `mode=${mode} needs a slug. Call project_list to see this machine's projects.`,
        });
      }

      const registry = yield* ProjectCatalogRegistry;
      const categories = yield* registry.list.pipe(Effect.mapError(storageFailed("file_thread")));
      if (input.slug !== undefined && !categories.some((entry) => entry.slug === input.slug)) {
        return yield* new ProjectToolError({
          operation: "file_thread",
          reason: "not_found",
          detail: `This machine has no project '${input.slug}'. Its projects are: ${
            categories.map((entry) => entry.slug).join(", ") || "(none)"
          }.`,
        });
      }

      const updated = yield* registry
        .fileThread({ mode, threadId, slug: input.slug ?? null })
        .pipe(Effect.mapError(storageFailed("file_thread")));

      // Reported by re-deriving rather than by echoing the request: after an
      // unfile the answer is whatever the folder now says, which is exactly the
      // thing the caller cannot work out for itself.
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const shell = yield* projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(Effect.mapError(storageFailed("file_thread")));
      const membership = resolveLocalProjectMembership({
        categories: updated,
        threads: shell.threads
          .filter(isLiveThread)
          .map((thread) => ({ id: thread.id, projectId: thread.projectId })),
      });
      let landed: ProjectCategorySlug | null = null;
      for (const [slug, ids] of membership) {
        if (ids.includes(threadId)) {
          landed = slug;
          break;
        }
      }

      return { threadId, slug: landed, mode };
    }),

  project_set_icon: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireRead("set_icon");

      // Validated here as well as at the schema, because the two produce
      // different things: the schema's refusal is a decode error the agent sees
      // as malformed input, and this is the tool telling it, in the tool's own
      // error shape, exactly which rule the image broke and what to do about
      // it. Both call the same function, so they cannot disagree about what is
      // acceptable — only about how they say so.
      const rejection = validateProjectCategoryIcon(input.icon);
      if (rejection !== null) {
        return yield* new ProjectToolError({
          operation: "set_icon",
          reason: "invalid",
          detail: describeProjectCategoryIconRejection(rejection),
        });
      }

      const state = yield* readMachineState("set_icon");

      // Whose project this thread is in, which is what "omit slug" means. Read
      // from the same resolver every other membership answer comes from rather
      // than from the catalog directly, so a thread filed by its folder is as
      // much a member as one filed explicitly.
      let ownSlug: ProjectCategorySlug | null = null;
      for (const [slug, ids] of state.membership) {
        if (ids.includes(invocation.threadId)) {
          ownSlug = slug;
          break;
        }
      }

      const slug = input.slug ?? ownSlug;
      if (slug === undefined || slug === null) {
        return yield* new ProjectToolError({
          operation: "set_icon",
          reason: "not_found",
          detail:
            "This thread is not filed under any project on this machine, so there is no icon to set. Call project_file_thread to file it, or pass a slug.",
        });
      }

      // The gate, and the same one `project_file_thread` applies. An icon is
      // display: it is what the project *is*, and it lands on every surface on
      // every machine. Restyling the project you are working in is housekeeping;
      // restyling somebody else's is an orchestrator's act.
      if (slug !== ownSlug && !invocation.capabilities.has("peers-operate")) {
        return yield* new ProjectToolError({
          operation: "set_icon",
          reason: "capability_unavailable",
          detail: `Only the designated master thread may set another project's icon. This thread is filed under ${
            ownSlug ?? "no project"
          }; call this without a slug to set that one.`,
        });
      }

      if (!state.categories.some((entry) => entry.slug === slug)) {
        return yield* new ProjectToolError({
          operation: "set_icon",
          reason: "not_found",
          detail: `This machine has no project '${slug}'. Its projects are: ${
            state.categories.map((entry) => entry.slug).join(", ") || "(none)"
          }.`,
        });
      }

      const registry = yield* ProjectCatalogRegistry;
      // No `displayUpdatedAt`: the server's own clock is the right stamp for a
      // write nobody is fanning out. The client stamps its own only because it
      // sends one value to four machines.
      const result = yield* registry
        .upsert({ slug, display: { icon: input.icon } })
        .pipe(Effect.mapError(storageFailed("set_icon")));

      return {
        slug,
        hasIcon: result.category.display.icon.length > 0,
        iconLength: result.category.display.icon.length,
        updatedAt: result.category.display.updatedAt,
      };
    }),
} satisfies Parameters<typeof ProjectsToolkit.toLayer>[0];

export const ProjectsToolkitHandlersLive = ProjectsToolkit.toLayer(handlers);

/**
 * The handler map, for tests that want to call a tool the way MCP does without
 * standing up the streaming toolkit runtime around it. Same functions the layer
 * above registers — the gate under test is inside them, not around them.
 */
export const __testing = { handlers };
