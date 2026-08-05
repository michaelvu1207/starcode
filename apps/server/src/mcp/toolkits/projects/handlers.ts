/**
 * Local and fleet-aware handlers for the project-management toolkit.
 *
 * The server owns the administrative credentials for registered fleet nodes,
 * so agents name a node but never receive its endpoint or credential. Logical
 * project metadata uses the catalog API; physical project lifecycle uses the
 * same orchestration commands as the StarCode UI.
 *
 * @module ProjectHandlers
 */
import {
  type ClientOrchestrationCommand,
  CommandId,
  describeProjectCategoryIconRejection,
  featureMapEntryInProject,
  FleetNodeName,
  type FleetNode,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  ProjectId,
  ProjectToolError,
  resolveLocalProjectMembership,
  validateProjectCategoryIcon,
  type ProjectCatalogFileThreadMode,
  type ProjectCatalogLocation,
  type ProjectCatalogUpsertRequest,
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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { FeatureMapRegistry } from "../../../featureMap/FeatureMapRegistry.ts";
import {
  dispatchFleetCommand,
  fetchFleetFeatureMap,
  fetchFleetProjectCatalog,
  fetchFleetProjectCatalogLocations,
  fetchFleetShellSnapshot,
  fileFleetProjectThread,
  removeFleetProjectCatalog,
  upsertFleetProjectCatalog,
} from "../../../fleet/FleetClient.ts";
import { FleetRegistry } from "../../../fleet/FleetRegistry.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import { permitsThreadOperation } from "../../../threads/ThreadCapability.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectsToolkit } from "./tools.ts";

interface LocalProjectTarget {
  readonly local: true;
  readonly node: FleetNodeName;
  readonly environmentId: string;
  readonly label: string;
  readonly platform: FleetNode["platform"];
}

interface RemoteProjectTarget {
  readonly local: false;
  readonly node: FleetNodeName;
  readonly environmentId: string;
  readonly label: string;
  readonly platform: FleetNode["platform"];
  readonly baseUrl: string;
  readonly credential: string;
}

type ProjectTarget = LocalProjectTarget | RemoteProjectTarget;

/** Every provider session receives `threads`, which is also project authority. */
const requireProjectCapability = (operation: ProjectToolOperation) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (
      !permitsThreadOperation(
        { kind: "mcp", capabilities: invocation.capabilities },
        { operation: "read" },
      )
    ) {
      return yield* new ProjectToolError({
        operation,
        reason: "capability_unavailable",
        detail: "This MCP credential does not grant project-management access.",
      });
    }
    return invocation;
  });

const storageFailed = (operation: ProjectToolOperation, action = "accessed") =>
  new ProjectToolError({
    operation,
    reason: "storage_failed",
    detail: `The project catalog could not be ${action} on this connection.`,
  });

const nodeUnreachable = (operation: ProjectToolOperation, node: FleetNodeName) =>
  new ProjectToolError({
    operation,
    reason: "node_unreachable",
    detail: `The fleet connection '${node}' is not registered, has no administrative credential, or could not be reached.`,
  });

const dispatchFailed = (operation: ProjectToolOperation, node: FleetNodeName) =>
  new ProjectToolError({
    operation,
    reason: "dispatch_failed",
    detail: `The project lifecycle change was rejected on '${node}'. No workspace files were deleted.`,
  });

const isLiveThread = (thread: { readonly archivedAt: string | null }): boolean =>
  thread.archivedAt === null;

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
  hasIcon: input.category.display.icon.length > 0,
});

/** Resolve a public fleet node name without exposing its private transport. */
const resolveTarget = (operation: ProjectToolOperation, requested?: FleetNodeName) =>
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const fleetRegistry = yield* FleetRegistry;
    const roster = yield* fleetRegistry.snapshot.pipe(Effect.option);
    const members = Option.match(roster, { onNone: () => [], onSome: (value) => value.members });
    const self = members.find((member) => member.node.environmentId === descriptor.environmentId);
    const localNode = self?.node.name ?? FleetNodeName.make("local");
    const localAliases = new Set<string>([
      "local",
      descriptor.environmentId,
      descriptor.label,
      localNode,
    ]);

    if (requested === undefined || localAliases.has(requested)) {
      return {
        local: true,
        node: localNode,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        platform: descriptor.platform,
      } satisfies LocalProjectTarget;
    }

    const member = members.find(
      (candidate) =>
        candidate.node.name === requested || candidate.node.environmentId === requested,
    );
    if (member === undefined) return yield* nodeUnreachable(operation, requested);

    const resolved = yield* fleetRegistry
      .resolveByEnvironmentId(member.node.environmentId)
      .pipe(Effect.catchCause(() => Effect.fail(nodeUnreachable(operation, requested))));
    if (Option.isNone(resolved)) return yield* nodeUnreachable(operation, requested);
    const endpoint =
      resolved.value.member.node.endpoints.find((candidate) => candidate.isDefault === true) ??
      resolved.value.member.node.endpoints[0];
    if (endpoint === undefined) return yield* nodeUnreachable(operation, requested);

    return {
      local: false,
      node: resolved.value.member.node.name,
      environmentId: resolved.value.member.node.environmentId,
      label: resolved.value.member.node.label,
      platform: resolved.value.member.node.platform,
      baseUrl: endpoint.httpBaseUrl,
      credential: resolved.value.credential,
    } satisfies RemoteProjectTarget;
  });

const readTargetCatalogAndShell = (
  operation: ProjectToolOperation,
  target: ProjectTarget,
  options: { readonly unreadableCatalogIsEmpty?: boolean } = {},
) =>
  Effect.gen(function* () {
    if (target.local) {
      const registry = yield* ProjectCatalogRegistry;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const categoriesEffect = options.unreadableCatalogIsEmpty
        ? registry.list.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not read the project catalog; reporting no projects", {
                cause,
              }).pipe(Effect.as([])),
            ),
          )
        : registry.list.pipe(Effect.mapError(() => storageFailed(operation)));
      const [categories, shell] = yield* Effect.all(
        [
          categoriesEffect,
          projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(Effect.mapError(() => storageFailed(operation))),
        ],
        { concurrency: 2 },
      );
      return { categories, shell };
    }

    const [catalog, shell] = yield* Effect.all(
      [
        fetchFleetProjectCatalog({
          baseUrl: target.baseUrl,
          credential: target.credential,
        }),
        fetchFleetShellSnapshot({
          baseUrl: target.baseUrl,
          credential: target.credential,
        }),
      ],
      { concurrency: 2 },
    ).pipe(Effect.catchCause(() => Effect.fail(nodeUnreachable(operation, target.node))));
    return { categories: catalog.categories, shell };
  });

const readMachineState = (
  operation: ProjectToolOperation,
  requested?: FleetNodeName,
  unreadableCatalogIsEmpty = false,
) =>
  Effect.gen(function* () {
    const target = yield* resolveTarget(operation, requested);
    const { categories, shell } = yield* readTargetCatalogAndShell(operation, target, {
      unreadableCatalogIsEmpty,
    });
    const liveThreads = shell.threads.filter(isLiveThread);
    return {
      target,
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

const locationsFor = (input: {
  readonly categories: ReadonlyArray<ProjectCategoryRecord>;
  readonly shell: OrchestrationShellSnapshot;
}): ReadonlyArray<ProjectCatalogLocation> => {
  const boundSlugByProjectId = new Map(
    input.categories.flatMap((category) =>
      category.local.bindings.map((binding) => [binding.projectId, category.slug] as const),
    ),
  );
  return input.shell.projects.map((project) => ({
    projectId: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    repositoryKey: project.repositoryIdentity?.canonicalKey ?? null,
    repositoryName:
      project.repositoryIdentity?.displayName ?? project.repositoryIdentity?.name ?? null,
    boundSlug: boundSlugByProjectId.get(project.id) ?? null,
  }));
};

const upsertOnTarget = (
  operation: ProjectToolOperation,
  target: ProjectTarget,
  request: ProjectCatalogUpsertRequest,
) =>
  Effect.gen(function* () {
    if (target.local) {
      const registry = yield* ProjectCatalogRegistry;
      return yield* registry
        .upsert(request)
        .pipe(Effect.mapError(() => storageFailed(operation, "updated")));
    }
    return yield* upsertFleetProjectCatalog({
      baseUrl: target.baseUrl,
      credential: target.credential,
      payload: request,
    }).pipe(Effect.catchCause(() => Effect.fail(nodeUnreachable(operation, target.node))));
  });

const removeOnTarget = (
  operation: ProjectToolOperation,
  target: ProjectTarget,
  slug: ProjectCategorySlug,
) =>
  Effect.gen(function* () {
    if (target.local) {
      const registry = yield* ProjectCatalogRegistry;
      return yield* registry
        .remove(slug)
        .pipe(Effect.mapError(() => storageFailed(operation, "updated")));
    }
    const result = yield* removeFleetProjectCatalog({
      baseUrl: target.baseUrl,
      credential: target.credential,
      payload: { slug },
    }).pipe(Effect.catchCause(() => Effect.fail(nodeUnreachable(operation, target.node))));
    return result.removed;
  });

const dispatchOnTarget = (
  operation: ProjectToolOperation,
  target: ProjectTarget,
  command: ClientOrchestrationCommand,
) =>
  Effect.gen(function* () {
    if (target.local) {
      const engine = yield* OrchestrationEngineService;
      return yield* engine
        .dispatch(command as OrchestrationCommand)
        .pipe(Effect.catchCause(() => Effect.fail(dispatchFailed(operation, target.node))));
    }
    return yield* dispatchFleetCommand({
      baseUrl: target.baseUrl,
      credential: target.credential,
      command,
    }).pipe(Effect.catchCause(() => Effect.fail(dispatchFailed(operation, target.node))));
  });

const bindLocation = (input: {
  readonly operation: ProjectToolOperation;
  readonly target: ProjectTarget;
  readonly categories: ReadonlyArray<ProjectCategoryRecord>;
  readonly slug: ProjectCategorySlug;
  readonly projectId: ProjectId;
  readonly mode: "bind" | "unbind";
  readonly preferred: boolean;
}) =>
  Effect.gen(function* () {
    const category = input.categories.find((entry) => entry.slug === input.slug);
    if (category === undefined) {
      return yield* new ProjectToolError({
        operation: input.operation,
        reason: "not_found",
        detail: `Connection '${input.target.node}' has no logical project '${input.slug}'.`,
      });
    }
    const current = category.local.bindings.map((binding) => binding.projectId);
    const bindings =
      input.mode === "bind"
        ? current.includes(input.projectId)
          ? current
          : [...current, input.projectId]
        : current.filter((projectId) => projectId !== input.projectId);
    const currentPreferred = category.local.defaults.preferredProjectId ?? null;
    const preferredProjectId =
      input.mode === "unbind" && currentPreferred === input.projectId
        ? null
        : input.mode === "bind" && input.preferred
          ? input.projectId
          : currentPreferred;

    const result = yield* upsertOnTarget(input.operation, input.target, {
      slug: input.slug,
      local: {
        bindings,
        defaults: { ...category.local.defaults, preferredProjectId },
      },
    });
    if (input.mode === "bind") {
      const previousOwners = input.categories.filter(
        (candidate) =>
          candidate.slug !== input.slug &&
          candidate.local.bindings.some((binding) => binding.projectId === input.projectId),
      );
      yield* Effect.forEach(
        previousOwners,
        (previous) =>
          upsertOnTarget(input.operation, input.target, {
            slug: previous.slug,
            local: {
              bindings: previous.local.bindings
                .map((binding) => binding.projectId)
                .filter((projectId) => projectId !== input.projectId),
              defaults: {
                ...previous.local.defaults,
                ...(previous.local.defaults.preferredProjectId === input.projectId
                  ? { preferredProjectId: null }
                  : {}),
              },
            },
          }),
        { concurrency: 1, discard: true },
      );
    }
    return {
      category: result.category,
      bindings,
      preferredProjectId,
    };
  });

const handlers = {
  project_list: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("list");
      const state = yield* readMachineState("list", input.node, true);
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
      yield* requireProjectCapability("get");
      const state = yield* readMachineState("get", input.node, true);
      const category = state.categories.find((entry) => entry.slug === input.slug);
      if (category === undefined) {
        return yield* new ProjectToolError({
          operation: "get",
          reason: "not_found",
          detail: `Connection '${state.target.node}' has no project '${input.slug}'. Its projects are: ${
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
            needsAttention: thread.hasPendingApprovals || thread.hasPendingUserInput,
            updatedAt: thread.updatedAt,
          }),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const entries = state.target.local
        ? yield* Effect.gen(function* () {
            const featureRegistry = yield* FeatureMapRegistry;
            return yield* featureRegistry.list.pipe(Effect.catchCause(() => Effect.succeed([])));
          })
        : yield* fetchFleetFeatureMap({
            baseUrl: state.target.baseUrl,
            credential: state.target.credential,
          }).pipe(
            Effect.map((snapshot) => snapshot.entries),
            Effect.catchCause(() => Effect.fail(nodeUnreachable("get", state.target.node))),
          );
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
          return project === undefined
            ? null
            : {
                projectId: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
              };
        })
        .filter((location): location is ProjectToolLocation => location !== null);
      const hostname = state.target.local ? normalizeHostname(yield* HostProcessHostname) : null;
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
          environmentId: state.target.environmentId,
          label: state.target.label,
          hostname,
          platform: state.target.platform,
        },
        locations,
        threads,
        features,
        masterThreadId: masterThreadId.length === 0 ? null : (masterThreadId as ThreadId),
      };
    }),

  project_locations: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("locations");
      const target = yield* resolveTarget("locations", input.node);
      const locations = target.local
        ? yield* readTargetCatalogAndShell("locations", target, {
            unreadableCatalogIsEmpty: true,
          }).pipe(Effect.map((state) => locationsFor(state)))
        : yield* fetchFleetProjectCatalogLocations({
            baseUrl: target.baseUrl,
            credential: target.credential,
          }).pipe(
            Effect.map((page) => page.locations),
            Effect.catchCause(() => Effect.fail(nodeUnreachable("locations", target.node))),
          );
      return { node: target.node, local: target.local, locations };
    }),

  project_upsert: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("upsert");
      const target = yield* resolveTarget("upsert", input.node);
      const { node: _node, ...request } = input;
      const result = yield* upsertOnTarget("upsert", target, request);
      return { node: target.node, local: target.local, ...result };
    }),

  project_remove: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("remove");
      const target = yield* resolveTarget("remove", input.node);
      const removed = yield* removeOnTarget("remove", target, input.slug);
      return { node: target.node, local: target.local, slug: input.slug, removed };
    }),

  project_bind_location: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("bind_location");
      const target = yield* resolveTarget("bind_location", input.node);
      const { categories, shell } = yield* readTargetCatalogAndShell("bind_location", target);
      if (!shell.projects.some((project) => project.id === input.projectId)) {
        return yield* new ProjectToolError({
          operation: "bind_location",
          reason: "not_found",
          detail: `Connection '${target.node}' has no physical project '${input.projectId}'.`,
        });
      }
      const mode = input.mode ?? "bind";
      if (mode === "unbind" && input.preferred === true) {
        return yield* new ProjectToolError({
          operation: "bind_location",
          reason: "invalid",
          detail: "preferred=true is only valid when binding a location.",
        });
      }
      const result = yield* bindLocation({
        operation: "bind_location",
        target,
        categories,
        slug: input.slug,
        projectId: input.projectId,
        mode,
        preferred: input.preferred ?? false,
      });
      return {
        node: target.node,
        local: target.local,
        slug: input.slug,
        projectId: input.projectId,
        mode,
        preferredProjectId: result.preferredProjectId,
        bindings: result.bindings,
      };
    }),

  project_location_create: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("location_create");
      const target = yield* resolveTarget("location_create", input.node);
      const state = yield* readTargetCatalogAndShell("location_create", target);
      if (state.shell.projects.some((project) => project.workspaceRoot === input.workspaceRoot)) {
        return yield* new ProjectToolError({
          operation: "location_create",
          reason: "invalid",
          detail: `Connection '${target.node}' already has a project at that workspace path.`,
        });
      }
      if (
        input.bindSlug !== undefined &&
        !state.categories.some((category) => category.slug === input.bindSlug)
      ) {
        return yield* new ProjectToolError({
          operation: "location_create",
          reason: "not_found",
          detail: `Connection '${target.node}' has no logical project '${input.bindSlug}'.`,
        });
      }

      const crypto = yield* Crypto.Crypto;
      const projectId = ProjectId.make(`project-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const command: ClientOrchestrationCommand = {
        type: "project.create",
        commandId: CommandId.make(
          `mcp-project-create-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        ...(input.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        createdAt,
      } as ClientOrchestrationCommand;
      yield* dispatchOnTarget("location_create", target, command);
      if (input.bindSlug !== undefined) {
        yield* bindLocation({
          operation: "location_create",
          target,
          categories: state.categories,
          slug: input.bindSlug,
          projectId,
          mode: "bind",
          preferred: input.preferred ?? false,
        });
      }
      return {
        node: target.node,
        local: target.local,
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        boundSlug: input.bindSlug ?? null,
      };
    }),

  project_location_update: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("location_update");
      const target = yield* resolveTarget("location_update", input.node);
      const state = yield* readTargetCatalogAndShell("location_update", target);
      if (!state.shell.projects.some((project) => project.id === input.projectId)) {
        return yield* new ProjectToolError({
          operation: "location_update",
          reason: "not_found",
          detail: `Connection '${target.node}' has no physical project '${input.projectId}'.`,
        });
      }
      if (
        input.title === undefined &&
        input.workspaceRoot === undefined &&
        input.defaultModelSelection === undefined &&
        input.scripts === undefined
      ) {
        return yield* new ProjectToolError({
          operation: "location_update",
          reason: "invalid",
          detail: "Pass at least one field to update.",
        });
      }
      const crypto = yield* Crypto.Crypto;
      const command: ClientOrchestrationCommand = {
        type: "project.meta.update",
        commandId: CommandId.make(
          `mcp-project-update-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        projectId: input.projectId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
      } as ClientOrchestrationCommand;
      yield* dispatchOnTarget("location_update", target, command);
      return {
        node: target.node,
        local: target.local,
        projectId: input.projectId,
        updated: true,
      };
    }),

  project_location_remove: (input) =>
    Effect.gen(function* () {
      yield* requireProjectCapability("location_remove");
      const target = yield* resolveTarget("location_remove", input.node);
      const state = yield* readTargetCatalogAndShell("location_remove", target);
      if (!state.shell.projects.some((project) => project.id === input.projectId)) {
        return yield* new ProjectToolError({
          operation: "location_remove",
          reason: "not_found",
          detail: `Connection '${target.node}' has no physical project '${input.projectId}'.`,
        });
      }
      const crypto = yield* Crypto.Crypto;
      yield* dispatchOnTarget("location_remove", target, {
        type: "project.delete",
        commandId: CommandId.make(
          `mcp-project-delete-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        projectId: input.projectId,
        ...(input.force === undefined ? {} : { force: input.force }),
      } as ClientOrchestrationCommand);

      const affected = state.categories.filter((category) =>
        category.local.bindings.some((binding) => binding.projectId === input.projectId),
      );
      yield* Effect.forEach(
        affected,
        (category) =>
          upsertOnTarget("location_remove", target, {
            slug: category.slug,
            local: {
              bindings: category.local.bindings
                .map((binding) => binding.projectId)
                .filter((projectId) => projectId !== input.projectId),
              defaults: {
                ...category.local.defaults,
                ...(category.local.defaults.preferredProjectId === input.projectId
                  ? { preferredProjectId: null }
                  : {}),
              },
            },
          }),
        { concurrency: 1, discard: true },
      );
      return {
        node: target.node,
        local: target.local,
        projectId: input.projectId,
        removed: true,
        workspaceDeleted: false as const,
      };
    }),

  project_file_thread: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireProjectCapability("file_thread");
      const target = yield* resolveTarget("file_thread", input.node);
      if (!target.local && input.threadId === undefined) {
        return yield* new ProjectToolError({
          operation: "file_thread",
          reason: "invalid",
          detail: "Pass threadId when filing a thread on another connection.",
        });
      }
      const threadId = input.threadId ?? invocation.threadId;
      const mode: ProjectCatalogFileThreadMode = input.mode ?? "assign";
      if (mode === "unfile") {
        if (input.slug !== undefined) {
          return yield* new ProjectToolError({
            operation: "file_thread",
            reason: "invalid",
            detail: "unfile takes no slug.",
          });
        }
      } else if (input.slug === undefined) {
        return yield* new ProjectToolError({
          operation: "file_thread",
          reason: "invalid",
          detail: `mode=${mode} needs a slug.`,
        });
      }

      const { categories, shell } = yield* readTargetCatalogAndShell("file_thread", target);
      if (input.slug !== undefined && !categories.some((entry) => entry.slug === input.slug)) {
        return yield* new ProjectToolError({
          operation: "file_thread",
          reason: "not_found",
          detail: `Connection '${target.node}' has no project '${input.slug}'.`,
        });
      }
      const updated = target.local
        ? yield* Effect.gen(function* () {
            const registry = yield* ProjectCatalogRegistry;
            return yield* registry
              .fileThread({ mode, threadId, slug: input.slug ?? null })
              .pipe(Effect.mapError(() => storageFailed("file_thread", "updated")));
          })
        : yield* fileFleetProjectThread({
            baseUrl: target.baseUrl,
            credential: target.credential,
            payload: { mode, threadId, slug: input.slug ?? null },
          }).pipe(
            Effect.map((snapshot) => snapshot.categories),
            Effect.catchCause(() => Effect.fail(nodeUnreachable("file_thread", target.node))),
          );
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
      const invocation = yield* requireProjectCapability("set_icon");
      const rejection = validateProjectCategoryIcon(input.icon);
      if (rejection !== null) {
        return yield* new ProjectToolError({
          operation: "set_icon",
          reason: "invalid",
          detail: describeProjectCategoryIconRejection(rejection),
        });
      }
      const state = yield* readMachineState("set_icon", input.node);
      let ownSlug: ProjectCategorySlug | null = null;
      if (state.target.local) {
        for (const [slug, ids] of state.membership) {
          if (ids.includes(invocation.threadId)) {
            ownSlug = slug;
            break;
          }
        }
      }
      const slug = input.slug ?? ownSlug;
      if (slug === undefined || slug === null) {
        return yield* new ProjectToolError({
          operation: "set_icon",
          reason: "not_found",
          detail: state.target.local
            ? "This thread is not filed under a project; pass slug or call project_file_thread first."
            : "Pass slug when setting an icon on another connection.",
        });
      }
      if (!state.categories.some((entry) => entry.slug === slug)) {
        return yield* new ProjectToolError({
          operation: "set_icon",
          reason: "not_found",
          detail: `Connection '${state.target.node}' has no project '${slug}'.`,
        });
      }
      const result = yield* upsertOnTarget("set_icon", state.target, {
        slug,
        display: { icon: input.icon },
      });
      return {
        slug,
        hasIcon: result.category.display.icon.length > 0,
        iconLength: result.category.display.icon.length,
        updatedAt: result.category.display.updatedAt,
      };
    }),
} satisfies Parameters<typeof ProjectsToolkit.toLayer>[0];

export const ProjectsToolkitHandlersLive = ProjectsToolkit.toLayer(handlers);

export const __testing = { handlers };
