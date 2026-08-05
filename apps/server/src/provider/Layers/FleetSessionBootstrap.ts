/**
 * Live, credential-free provider-session bootstrap snapshot.
 *
 * This is the only provider-layer module that knows how fleet membership,
 * orchestration projections, project catalog metadata, and orchestrator
 * settings combine. Adapters consume the narrow snapshot service and remain
 * independent of all four persistence systems.
 *
 * @module provider/Layers/FleetSessionBootstrap
 */
import {
  resolveLocalProjectMembership,
  type FleetMember,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectCategoryRecord,
  type ServerSettings,
  type ThreadId,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as FleetRegistry from "../../fleet/FleetRegistry.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectCatalogRegistry,
  ProjectCatalogRegistryError,
} from "../../projectCatalog/ProjectCatalogRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  FleetSessionBootstrap,
  type FleetSessionBootstrapSnapshot,
} from "../FleetSessionBootstrap.ts";

const recoverWith = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  message: string,
  fallback: A,
): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.catchCause(() => Effect.logWarning(message).pipe(Effect.as(fallback))));

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fleetRegistry = yield* FleetRegistry.FleetRegistry;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectCatalog = yield* ProjectCatalogRegistry;
  const serverSettings = yield* ServerSettingsService;

  return FleetSessionBootstrap.of({
    snapshot: ({ threadId }) =>
      Effect.gen(function* () {
        const [localDescriptor, fleetMembers, threadOption, categories, settings] =
          yield* Effect.all(
            [
              environment.getDescriptor,
              recoverWith<ReadonlyArray<FleetMember>, FleetRegistry.FleetRegistryStateError, never>(
                fleetRegistry.snapshot.pipe(Effect.map((roster) => roster.members)),
                "fleet roster unavailable for provider session bootstrap",
                [],
              ),
              recoverWith(
                projectionSnapshotQuery.getThreadShellById(threadId),
                "thread projection unavailable for provider session bootstrap",
                Option.none<OrchestrationThreadShell>(),
              ),
              recoverWith<ReadonlyArray<ProjectCategoryRecord>, ProjectCatalogRegistryError, never>(
                projectCatalog.list,
                "project catalog unavailable for provider session bootstrap",
                [],
              ),
              recoverWith(
                serverSettings.getSettings.pipe(Effect.map(Option.some)),
                "server settings unavailable for provider session bootstrap",
                Option.none<ServerSettings>(),
              ),
            ],
            { concurrency: "unbounded" },
          );

        const thread = Option.getOrUndefined(threadOption);
        const membership =
          thread === undefined
            ? new Map<string, ReadonlyArray<ThreadId>>()
            : resolveLocalProjectMembership({
                categories,
                threads: [{ id: thread.id, projectId: thread.projectId }],
              });
        const projectSlug =
          thread === undefined
            ? undefined
            : [...membership].find(([, threadIds]) => threadIds.includes(thread.id))?.[0];
        const category =
          projectSlug === undefined
            ? undefined
            : categories.find((candidate) => candidate.slug === projectSlug);
        const localProjectOption =
          thread === undefined
            ? Option.none<OrchestrationProjectShell>()
            : yield* recoverWith(
                projectionSnapshotQuery.getProjectShellById(thread.projectId),
                "project projection unavailable for provider session bootstrap",
                Option.none<OrchestrationProjectShell>(),
              );
        const localProject = Option.getOrUndefined(localProjectOption);
        const settingsValue = Option.getOrUndefined(settings);
        const fleetOrchestratorThreadId =
          settingsValue?.workbenchMasterThreadId.trim() || undefined;
        const projectOrchestratorThreadId = category?.local.masterThreadId.trim() || undefined;

        const orchestrator: FleetSessionBootstrapSnapshot["orchestrator"] =
          fleetOrchestratorThreadId === threadId
            ? { role: "fleet" }
            : projectOrchestratorThreadId === threadId
              ? { role: "project" }
              : {
                  role: "worker",
                  ...((projectOrchestratorThreadId ?? fleetOrchestratorThreadId)
                    ? {
                        designatedThreadId: (projectOrchestratorThreadId ??
                          fleetOrchestratorThreadId) as ThreadId,
                      }
                    : {}),
                };

        return {
          localNode: {
            environmentId: localDescriptor.environmentId,
            label: localDescriptor.label,
          },
          reachableNodes: fleetMembers.map(({ node }) => ({
            environmentId: node.environmentId,
            label: node.label,
          })),
          thread: {
            threadId,
            ...(thread?.title ? { title: thread.title } : {}),
          },
          ...(category
            ? {
                project: {
                  slug: category.slug,
                  title: category.display.title,
                  ...(category.display.notes ? { notes: category.display.notes } : {}),
                },
              }
            : localProject
              ? { project: { title: localProject.title } }
              : {}),
          orchestrator,
        } satisfies FleetSessionBootstrapSnapshot;
      }),
  });
});

export const layer: Layer.Layer<
  FleetSessionBootstrap,
  never,
  | FleetRegistry.FleetRegistry
  | ServerEnvironment.ServerEnvironment
  | ProjectionSnapshotQuery
  | ProjectCatalogRegistry
  | ServerSettingsService
> = Layer.effect(FleetSessionBootstrap, make);
