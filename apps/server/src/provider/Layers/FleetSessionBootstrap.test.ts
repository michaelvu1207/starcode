import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FleetRoster,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectCategoryRecord,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as FleetRegistry from "../../fleet/FleetRegistry.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../../projectCatalog/ProjectCatalogRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { FleetSessionBootstrap } from "../FleetSessionBootstrap.ts";
import * as FleetSessionBootstrapLive from "./FleetSessionBootstrap.ts";

const threadId = ThreadId.make("thread-bootstrap");
const projectId = ProjectId.make("project-starcode");
const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

const thread = {
  id: threadId,
  projectId,
  title: "Implement the fleet bootstrap",
} as OrchestrationThreadShell;

const project = {
  id: projectId,
  title: "StarCode checkout",
} as OrchestrationProjectShell;

const category = {
  slug: "starcode",
  display: {
    title: "StarCode",
    notes: "Follow the unified thread architecture.",
  },
  local: {
    bindings: [{ projectId, boundAt: "2026-01-01T00:00:00.000Z" }],
    threadIds: [],
    excludedThreadIds: [],
    masterThreadId: threadId,
  },
} as unknown as ProjectCategoryRecord;

const roster = {
  version: 1,
  revision: 2,
  members: [
    {
      node: {
        environmentId: remoteEnvironmentId,
        name: "simforge",
        label: "SimForge",
      },
    },
  ],
  tombstones: [],
} as unknown as FleetRoster;

const layer = FleetSessionBootstrapLive.layer.pipe(
  Layer.provideMerge(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(localEnvironmentId),
      getDescriptor: Effect.succeed({
        environmentId: localEnvironmentId,
        label: "MacBook Pro",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "test",
        capabilities: { repositoryIdentity: true },
      }),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(FleetRegistry.FleetRegistry)({
      snapshot: Effect.succeed(roster),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeed(Option.some(thread)),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectCatalogRegistry)({
      list: Effect.succeed([category]),
    }),
  ),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      workbenchMasterThreadId: "another-thread",
    }),
  ),
);

it.effect("builds the production bootstrap from fleet, projection, catalog, and settings", () =>
  Effect.gen(function* () {
    const bootstrap = yield* FleetSessionBootstrap;
    const snapshot = yield* bootstrap.snapshot({ threadId });

    NodeAssert.deepStrictEqual(snapshot, {
      localNode: {
        environmentId: localEnvironmentId,
        label: "MacBook Pro",
      },
      reachableNodes: [
        {
          environmentId: remoteEnvironmentId,
          label: "SimForge",
        },
      ],
      thread: {
        threadId,
        title: "Implement the fleet bootstrap",
      },
      project: {
        slug: "starcode",
        title: "StarCode",
        notes: "Follow the unified thread architecture.",
      },
      orchestrator: {
        role: "project",
      },
    });
  }).pipe(Effect.provide(layer)),
);
