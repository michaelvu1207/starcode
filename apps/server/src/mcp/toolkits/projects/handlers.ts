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
  ProjectToolError,
  resolveLocalProjectMembership,
  type ProjectCatalogFileThreadMode,
  type ProjectCategoryRecord,
  type ProjectCategorySlug,
  type ProjectToolFeature,
  type ProjectToolLocation,
  type ProjectToolSummary,
  type ProjectToolThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
const requireRead = (operation: "list" | "get" | "file_thread") =>
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

const storageFailed = (operation: "list" | "get" | "file_thread") => (cause: unknown) =>
  new ProjectToolError({
    operation,
    reason: "storage_failed",
    detail: `The project catalog could not be read on this machine. ${String(cause)}`,
  });

/** A thread is this machine's business only while it exists and is not archived. */
const isLiveThread = (thread: { readonly archivedAt: string | null }): boolean =>
  thread.archivedAt === null;

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
});

/**
 * The catalog, the projection and the feature map, read together.
 *
 * One place rather than per handler because both reads need the same three, and
 * because reading them concurrently is the difference between a tool call an
 * agent waits on and one it does not notice.
 */
const readMachineState = (operation: "list" | "get" | "file_thread") =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const [categories, shell] = yield* Effect.all(
      [
        registry.list.pipe(Effect.mapError(storageFailed(operation))),
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
            settled: thread.settledAt !== null || thread.settledOverride === "settled",
            updatedAt: thread.updatedAt,
          }),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

      // The feature map is this machine's own registry and is keyed by thread,
      // so scoping it to a project is a set lookup rather than a second source
      // of truth. A feature with no thread cannot be attributed to a project
      // and is left out rather than guessed at.
      const featureRegistry = yield* FeatureMapRegistry;
      const entries = yield* featureRegistry.list.pipe(Effect.catchCause(() => Effect.succeed([])));
      const features = entries
        .filter((entry) => entry.threadId !== null && threadIds.has(entry.threadId))
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

      const masterThreadId = category.local.masterThreadId.trim();
      return {
        project: summarize({
          category,
          workspaceRootByProjectId: state.workspaceRootByProjectId,
          threadCount: threads.length,
        }),
        notes: category.display.notes,
        links: category.display.links,
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
} satisfies Parameters<typeof ProjectsToolkit.toLayer>[0];

export const ProjectsToolkitHandlersLive = ProjectsToolkit.toLayer(handlers);

/**
 * The handler map, for tests that want to call a tool the way MCP does without
 * standing up the streaming toolkit runtime around it. Same functions the layer
 * above registers — the gate under test is inside them, not around them.
 */
export const __testing = { handlers };
