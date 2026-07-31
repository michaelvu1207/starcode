/**
 * The master gate, tested at the seam that actually enforces it.
 *
 * The invariant under test is not "the tool handler refuses" — it is that a
 * session which is not the designated master never receives a credential
 * carrying `peers-operate` in the first place. That is what makes the gate
 * structural rather than a check an agent could get around.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_PROJECT_CATEGORY_MASTER_DEFAULTS,
  EnvironmentId,
  ProjectCategorySlug,
  ProviderInstanceId,
  ThreadId,
  type ProjectCategoryRecord,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  ProjectCatalogRegistry,
  ProjectCatalogRegistryError,
} from "../projectCatalog/ProjectCatalogRegistry.ts";
import { layerTest as serverSettingsLayerTest, ServerSettingsService } from "../serverSettings.ts";
import { __testing } from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const masterThreadId = ThreadId.make("thread-master");
const workerThreadId = ThreadId.make("thread-worker");
const projectMasterThreadId = ThreadId.make("thread-project-master");

/** One catalog record, reduced to the only field the gate reads. */
const category = (slug: string, master: string): ProjectCategoryRecord => ({
  slug: ProjectCategorySlug.make(slug),
  createdAt: "2026-07-25T00:00:00.000Z",
  display: {
    title: slug,
    summary: "",
    accent: "",
    glyph: "",
    icon: "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: null,
    updatedAt: "2026-07-25T00:00:00.000Z",
  },
  local: {
    bindings: [],
    threadIds: [],
    excludedThreadIds: [],
    masterThreadId: master,
    masterDefaults: DEFAULT_PROJECT_CATEGORY_MASTER_DEFAULTS,
    defaults: {},
    updatedAt: "2026-07-25T00:00:00.000Z",
  },
});

const catalogLayer = (categories: ReadonlyArray<ProjectCategoryRecord>) =>
  Layer.mock(ProjectCatalogRegistry)({ list: Effect.succeed(categories) });

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
} as unknown as HttpServer.HttpServer["Service"]);

const environmentLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(environmentId),
});

/**
 * Issues a credential for one thread against a server configured as given.
 *
 * `catalog` defaults to a machine with no projects, which is what every test
 * written before F16 assumed and what a server that has never opened the
 * projects view still is.
 */
const capabilitiesFor = (
  threadId: ThreadId,
  configuredMaster: string,
  catalog: Layer.Layer<ProjectCatalogRegistry> = catalogLayer([]),
) =>
  Effect.gen(function* () {
    const registry = yield* __testing.make({ now: () => 1_000 });
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const scope = yield* registry.resolve(issued.config.authorizationHeader.replace("Bearer ", ""));
    return [...(scope?.capabilities ?? [])].toSorted();
  }).pipe(
    Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
    Effect.provide(
      Layer.mergeAll(
        environmentLayer,
        serverSettingsLayerTest({ workbenchMasterThreadId: configuredMaster }),
        catalog,
        NodeServices.layer,
      ),
    ),
  );

describe("workbench master gating", () => {
  it.effect("withholds peers-operate from an ordinary session", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(workerThreadId, masterThreadId);
      assert.deepStrictEqual(capabilities, ["peers", "preview", "threads"]);
      assert.notInclude(capabilities, "peers-operate");
      assert.notInclude(capabilities, "threads-operate");
    }),
  );

  it.effect("grants peers-operate to the designated master session", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(masterThreadId, masterThreadId);
      assert.deepStrictEqual(capabilities, [
        "features-operate",
        "peers",
        "peers-operate",
        "preview",
        "threads",
        "threads-operate",
      ]);
    }),
  );

  it.effect("grants nothing extra when no master is designated", () =>
    Effect.gen(function* () {
      // The unconfigured state is every server's default, so an empty setting
      // must never be read as "every thread is the master".
      const capabilities = yield* capabilitiesFor(masterThreadId, "");
      assert.deepStrictEqual(capabilities, ["peers", "preview", "threads"]);
    }),
  );

  it.effect("still gives every session the read and mailbox capability", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(workerThreadId, masterThreadId);
      assert.include(capabilities, "peers");
      assert.include(capabilities, "threads");
    }),
  );

  it.effect("tolerates whitespace around a configured thread id", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(masterThreadId, `  ${masterThreadId}  `);
      assert.include(capabilities, "peers-operate");
      assert.include(capabilities, "threads-operate");
    }),
  );
});

describe("project master gating", () => {
  it.effect("grants peers-operate to a thread a project names as its master", () =>
    Effect.gen(function* () {
      // The whole point of F16 phase 4: an orchestrator per project, with the
      // same tools the global one has. Without this the pane would render a
      // master that silently could not do the one thing masters are for.
      const capabilities = yield* capabilitiesFor(
        projectMasterThreadId,
        "",
        catalogLayer([category("alpamayo", projectMasterThreadId)]),
      );
      assert.deepStrictEqual(capabilities, [
        "features-operate",
        "peers",
        "peers-operate",
        "preview",
        "threads",
        "threads-operate",
      ]);
    }),
  );

  it.effect("keeps the global master's tools when a project names a different one", () =>
    Effect.gen(function* () {
      // Union, not replacement. Designating a project master must not demote
      // the machine's own /workbench orchestrator.
      const capabilities = yield* capabilitiesFor(
        masterThreadId,
        masterThreadId,
        catalogLayer([category("alpamayo", projectMasterThreadId)]),
      );
      assert.include(capabilities, "peers-operate");
      assert.include(capabilities, "threads-operate");
    }),
  );

  it.effect("withholds it from a thread no project and no setting names", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(
        workerThreadId,
        masterThreadId,
        catalogLayer([category("alpamayo", projectMasterThreadId)]),
      );
      assert.deepStrictEqual(capabilities, ["peers", "preview", "threads"]);
    }),
  );

  it.effect("reads an unset project master as naming nobody", () =>
    Effect.gen(function* () {
      // Every category starts with an empty masterThreadId, so an empty string
      // matching an empty request would hand operate to the whole machine.
      const capabilities = yield* capabilitiesFor(
        workerThreadId,
        "",
        catalogLayer([category("alpamayo", ""), category("arc-spirits", "")]),
      );
      assert.notInclude(capabilities, "peers-operate");
      assert.notInclude(capabilities, "threads-operate");
    }),
  );

  it.effect("still honours the settings master when the catalog cannot be read", () =>
    Effect.gen(function* () {
      // The two sources degrade independently on purpose: a corrupt catalog
      // file is not a reason to take the global orchestrator's tools away.
      const capabilities = yield* capabilitiesFor(
        masterThreadId,
        masterThreadId,
        Layer.mock(ProjectCatalogRegistry)({
          list: Effect.fail(
            new ProjectCatalogRegistryError({ operation: "load", cause: new Error("unreadable") }),
          ),
        }),
      );
      assert.include(capabilities, "peers-operate");
      assert.include(capabilities, "threads-operate");
    }),
  );

  it.effect("still honours a project master when settings cannot be read", () =>
    Effect.gen(function* () {
      const capabilities = yield* Effect.gen(function* () {
        const registry = yield* __testing.make({ now: () => 1_000 });
        const issued = yield* registry.issue({
          threadId: projectMasterThreadId,
          providerInstanceId: ProviderInstanceId.make("claude"),
        });
        const scope = yield* registry.resolve(
          issued.config.authorizationHeader.replace("Bearer ", ""),
        );
        return [...(scope?.capabilities ?? [])].toSorted();
      }).pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provide(
          Layer.mergeAll(
            environmentLayer,
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.die(new Error("settings unreadable")),
            }),
            catalogLayer([category("alpamayo", projectMasterThreadId)]),
            NodeServices.layer,
          ),
        ),
      );
      assert.include(capabilities, "peers-operate");
      assert.include(capabilities, "threads-operate");
    }),
  );
});
