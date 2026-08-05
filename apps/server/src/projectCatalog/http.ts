/**
 * Project catalog HTTP routes.
 *
 * One read of the registry, one read that joins it against the projection, and
 * three writes. Every handler is thin: the merge rules live in
 * `ProjectCatalogRegistry.ts` as pure functions, and this file only maps their
 * failures onto status codes.
 *
 * Note what is deliberately absent — a rename-slug route. The slug is the join
 * key across four machines, and a key that can change is a key that can
 * disagree.
 *
 * @module ProjectCatalogHttp
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  isValidProjectCatalogFileThreadRequest,
  type ProjectCatalogLocation,
  type ProjectCatalogLocationsPage,
  type ProjectCatalogSnapshot,
} from "@starcode/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { formatCatalogTimestamp, ProjectCatalogRegistry } from "./ProjectCatalogRegistry.ts";

export const projectCatalogHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projectCatalog",
  Effect.fnUntraced(function* (handlers) {
    const registry = yield* ProjectCatalogRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const computedAt = Clock.currentTimeMillis.pipe(Effect.map(formatCatalogTimestamp));

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projectCatalog.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);

          // An unreadable catalog is no projects, logged, not a failed request
          // — the same rule the feature-flow routes next door follow, and the
          // doctrine's own words (invariant 11). A missing file already
          // degrades inside the registry; this covers the other shape, a file
          // that exists and does not decode. Answering 500 there took the
          // machine's whole projects view out over one hand-edited JSON, and
          // the client cannot tell that apart from a server it cannot reach.
          const categories = yield* registry.list.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not read the project catalog; serving no projects", {
                cause,
              }).pipe(Effect.as([])),
            ),
          );
          return { categories, computedAt: yield* computedAt } satisfies ProjectCatalogSnapshot;
        }),
      )
      .handle(
        "locations",
        Effect.fn("environment.projectCatalog.locations")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);

          const [categories, shell] = yield* Effect.all(
            [
              // Same degradation as the snapshot above: an unreadable catalog
              // means nothing is bound, which is what an operator needs to see
              // in order to bind something.
              registry.list.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("could not read the project catalog; nothing is bound", {
                    cause,
                  }).pipe(Effect.as([])),
                ),
              ),
              projectionSnapshotQuery
                .getShellSnapshot()
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("project_catalog_locations_failed", cause),
                  ),
                ),
            ],
            { concurrency: 2 },
          );

          // One pass over the bindings rather than a scan per project: a
          // machine with a dozen categories and a hundred locations should not
          // be quadratic in either.
          const boundSlugByProjectId = new Map(
            categories.flatMap((category) =>
              category.local.bindings.map((binding) => [binding.projectId, category.slug] as const),
            ),
          );

          const locations = shell.projects.map(
            (project): ProjectCatalogLocation => ({
              projectId: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              repositoryKey: project.repositoryIdentity?.canonicalKey ?? null,
              repositoryName:
                project.repositoryIdentity?.displayName ?? project.repositoryIdentity?.name ?? null,
              boundSlug: boundSlugByProjectId.get(project.id) ?? null,
            }),
          );

          return { locations, computedAt: yield* computedAt } satisfies ProjectCatalogLocationsPage;
        }),
      )
      .handle(
        "upsert",
        Effect.fn("environment.projectCatalog.upsert")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          return yield* registry
            .upsert(args.payload)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("project_catalog_save_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.projectCatalog.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          // Removing a slug this machine never held is a success, not a 404:
          // the caller is fanning a delete out to four machines and only some
          // of them ever had a record.
          const removed = yield* registry
            .remove(args.payload.slug)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("project_catalog_save_failed", cause),
              ),
            );
          return { removed };
        }),
      )
      .handle(
        "fileThread",
        Effect.fn("environment.projectCatalog.fileThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          // The one precondition the payload schema cannot express: assigning
          // and excluding both need a category to act on, and unfiling names
          // none. Shared with the client so both sides agree on what is valid.
          if (!isValidProjectCatalogFileThreadRequest(args.payload)) {
            return yield* failEnvironmentInvalidRequest("invalid_project_catalog_request");
          }

          const categories = yield* registry
            .fileThread(args.payload)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("project_catalog_save_failed", cause),
              ),
            );
          return { categories, computedAt: yield* computedAt } satisfies ProjectCatalogSnapshot;
        }),
      );
  }),
);
