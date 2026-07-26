/**
 * The project tools' round trip, through the handlers an agent actually calls.
 *
 * Two things are worth testing here and they are not the same thing. One is the
 * gate: filing yourself is every worker's business, filing someone else is the
 * orchestrator's, and that split has to hold in the handler and not only in the
 * capability the credential carries. The other is the membership answer, which
 * is what every one of these tools is really reporting — derived from the
 * folder, overridden by hand, and re-derived after an unfile so the caller
 * learns where the thread actually landed rather than what it asked for.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectCategorySlug,
  ProjectId,
  ProjectToolError,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
  type ProjectGetResult,
  type ProjectListResult,
  type ProjectFileThreadToolResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import {
  FeatureMapRegistry,
  layer as featureMapRegistryLayer,
} from "../../../featureMap/FeatureMapRegistry.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectCatalogRegistry,
  layer as projectCatalogRegistryLayer,
} from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";

const CALLER_THREAD = ThreadId.make("thread-caller");
const OTHER_THREAD = ThreadId.make("thread-other");
const HUB_PROJECT = ProjectId.make("project-hub");
const SCRATCH_PROJECT = ProjectId.make("project-scratch");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: CALLER_THREAD,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/**
 * A shell snapshot with two folders and two threads, one in each.
 *
 * Enough to make every membership rule observable: bind one folder and the
 * thread in it is derived in, exclude it and it is out, file the other thread
 * by hand and it is in regardless of which folder it sits in.
 */
const shellSnapshot = {
  snapshotSequence: 1,
  updatedAt: "2026-07-25T00:00:00.000Z",
  projects: [
    {
      id: HUB_PROJECT,
      title: "hub",
      workspaceRoot: "/work/hub",
    },
    {
      id: SCRATCH_PROJECT,
      title: "scratch",
      workspaceRoot: "/work/scratch",
    },
  ],
  threads: [
    {
      id: CALLER_THREAD,
      projectId: HUB_PROJECT,
      title: "Caller",
      worktreePath: null,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      hasPendingApprovals: true,
      hasPendingUserInput: false,
      updatedAt: "2026-07-25T02:00:00.000Z",
    },
    {
      id: OTHER_THREAD,
      projectId: SCRATCH_PROJECT,
      title: "Other",
      worktreePath: null,
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      updatedAt: "2026-07-25T01:00:00.000Z",
    },
  ],
} as unknown as OrchestrationShellSnapshot;

const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
  getShellSnapshot: () => Effect.succeed(shellSnapshot),
});

/**
 * A machine that knows what it is called. `project_get` names it beside the
 * paths so a planner can tell a folder it can go and look at from one it
 * cannot — the doctrine's answer to visibility, which is observation rather
 * than a synced filesystem.
 */
const environmentLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
  getDescriptor: Effect.succeed({
    environmentId: EnvironmentId.make("environment-1"),
    label: "simforge1",
    platform: { os: "linux", arch: "arm64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: true },
  } as ExecutionEnvironmentDescriptor),
});

const makeLayer = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext)(invocation(capabilities)).pipe(
    Layer.provideMerge(projectionLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(projectCatalogRegistryLayer),
    Layer.provideMerge(featureMapRegistryLayer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-project-tools-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const MASTER = ["preview", "peers", "peers-operate", "features-operate"] as const;
const WORKER = ["preview", "peers"] as const;

type ToolResult = Partial<ProjectListResult & ProjectGetResult & ProjectFileThreadToolResult>;

type ToolContext =
  | McpInvocationContext.McpInvocationContext
  | ProjectCatalogRegistry
  | ProjectionSnapshotQuery
  | FeatureMapRegistry
  | ServerEnvironment.ServerEnvironment;

/** Calls one tool's handler directly — the same function MCP dispatches to. */
const call = (
  name: keyof typeof __testing.handlers,
  input: unknown,
): Effect.Effect<ToolResult, ProjectToolError, ToolContext> =>
  (
    __testing.handlers[name] as (
      value: unknown,
    ) => Effect.Effect<ToolResult, ProjectToolError, ToolContext>
  )(input);

/** Seeds the machine's catalog through the registry the handlers read. */
const seed = (slug: string, bindings: ReadonlyArray<ProjectId>) =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    yield* registry.upsert({
      slug: ProjectCategorySlug.make(slug),
      display: { title: slug },
      local: { bindings },
    });
  });

describe("project tools", () => {
  it.effect("lists what this machine files, with the folders and counts behind it", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const listed = yield* call("project_list", {});

      assert.strictEqual(listed.projects?.length, 1);
      const [project] = listed.projects!;
      assert.strictEqual(project?.slug, "hub");
      assert.deepStrictEqual([...(project?.boundWorkspaceRoots ?? [])], ["/work/hub"]);
      // Derived membership, with nothing filed by hand: the thread is in
      // because its folder is bound, which is the rule that makes the view
      // correct before anyone touches it.
      assert.strictEqual(project?.threadCount, 1);
      assert.strictEqual(project?.hasMaster, false);
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("hides archived projects unless asked, because they are not where work goes", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const registry = yield* ProjectCatalogRegistry;
      yield* registry.upsert({
        slug: ProjectCategorySlug.make("hub"),
        display: { archivedAt: "2026-07-24T00:00:00.000Z" },
      });

      assert.deepStrictEqual([...(yield* call("project_list", {})).projects!], []);
      assert.strictEqual(
        (yield* call("project_list", { includeArchived: true })).projects?.length,
        1,
      );
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("hands an agent the notes a human wrote, which is the point of the tool", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const registry = yield* ProjectCatalogRegistry;
      yield* registry.upsert({
        slug: ProjectCategorySlug.make("hub"),
        display: {
          notes: "Phase 0 and 1 are committed; conditions are still open.",
          links: [{ label: "Runbook", url: "https://example.invalid/runbook" }],
        },
      });

      const got = yield* call("project_get", { slug: "hub" });
      assert.strictEqual(got.notes, "Phase 0 and 1 are committed; conditions are still open.");
      assert.strictEqual(got.links?.[0]?.label, "Runbook");
      assert.deepStrictEqual(
        got.locations?.map((location) => location.workspaceRoot),
        ["/work/hub"],
      );
      // The one fact an orchestrator reading this needs: who is stuck.
      assert.strictEqual(got.threads?.[0]?.threadId, CALLER_THREAD);
      assert.strictEqual(got.threads?.[0]?.needsAttention, true);
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("names the projects it does have when asked for one it does not", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const refused = yield* call("project_get", { slug: "alpamayo" }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_found");
      assert.include(refused.detail ?? "", "hub");
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("lets a worker file itself, because that is the thread's own business", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      yield* seed("research", []);

      const filed = yield* call("project_file_thread", { slug: "research" });
      assert.strictEqual(filed.threadId, CALLER_THREAD);
      // An explicit add beats the binding that would have derived it into hub.
      assert.strictEqual(filed.slug, "research");

      const hub = yield* call("project_get", { slug: "hub" });
      assert.deepStrictEqual(
        [...(hub.threads ?? [])].map((thread) => thread.threadId),
        [],
      );
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("refuses a worker filing somebody else's thread", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const refused = yield* call("project_file_thread", {
        threadId: OTHER_THREAD,
        slug: "hub",
      }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "capability_unavailable");
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("lets the orchestrator file somebody else's thread", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const filed = yield* call("project_file_thread", { threadId: OTHER_THREAD, slug: "hub" });
      assert.strictEqual(filed.slug, "hub");

      const hub = yield* call("project_get", { slug: "hub" });
      assert.deepStrictEqual(
        [...(hub.threads ?? [])].map((thread) => thread.threadId).toSorted(),
        [CALLER_THREAD, OTHER_THREAD].toSorted(),
      );
    }).pipe(Effect.provide(makeLayer(MASTER))),
  );

  it.effect("reports where an unfiled thread landed, not what the caller asked for", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      yield* seed("research", []);
      yield* call("project_file_thread", { slug: "research" });

      // Unfiling drops the explicit claim, and the folder decides again — which
      // is a different answer from "nothing", and the one the caller cannot
      // work out for itself.
      const unfiled = yield* call("project_file_thread", { mode: "unfile" });
      assert.strictEqual(unfiled.slug, "hub");
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("takes a thread out of the project its folder would put it in", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const excluded = yield* call("project_file_thread", { mode: "exclude", slug: "hub" });
      assert.strictEqual(excluded.slug, null);
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("refuses a filing that names no project, and an unfile that names one", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);

      const noSlug = yield* call("project_file_thread", {}).pipe(Effect.flip);
      assert.strictEqual(noSlug.reason, "invalid");

      const bothWays = yield* call("project_file_thread", {
        mode: "unfile",
        slug: "hub",
      }).pipe(Effect.flip);
      assert.strictEqual(bothWays.reason, "invalid");

      const unknown = yield* call("project_file_thread", { slug: "nowhere" }).pipe(Effect.flip);
      assert.strictEqual(unknown.reason, "not_found");
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("reports the features bound to this project's threads, and no others", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const features = yield* FeatureMapRegistry;
      yield* features.create({ name: "Behaviour programs", threadId: CALLER_THREAD });
      yield* features.create({ name: "Something else entirely", threadId: OTHER_THREAD });
      // A feature with no thread and no project cannot be attributed to one, so
      // it is left out rather than guessed at.
      yield* features.create({ name: "Only an intention", planned: true });

      const got = yield* call("project_get", { slug: "hub" });
      assert.deepStrictEqual(
        got.features?.map((feature) => feature.name),
        ["Behaviour programs"],
      );
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("reaches a planned feature through the project it was filed under", () =>
    Effect.gen(function* () {
      // The load-bearing case: a planned feature has no thread, so before it
      // could carry a slug no membership rule could reach it at all.
      yield* seed("hub", [HUB_PROJECT]);
      const features = yield* FeatureMapRegistry;
      yield* features.create({
        name: "Intended",
        planned: true,
        slug: ProjectCategorySlug.make("hub"),
      });
      yield* features.create({
        name: "Somebody else's intention",
        planned: true,
        slug: ProjectCategorySlug.make("scratch"),
      });

      const got = yield* call("project_get", { slug: "hub" });
      assert.deepStrictEqual(
        got.features?.map((feature) => feature.name),
        ["Intended"],
      );
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("lets a filed feature outrank the project its thread sits in", () =>
    Effect.gen(function* () {
      yield* seed("hub", [HUB_PROJECT]);
      const features = yield* FeatureMapRegistry;
      // The thread is in hub; the orchestrator filed the feature elsewhere.
      // Refiling a thread is not a statement about the feature.
      yield* features.create({
        name: "Filed away",
        threadId: CALLER_THREAD,
        slug: ProjectCategorySlug.make("scratch"),
      });

      const got = yield* call("project_get", { slug: "hub" });
      assert.deepStrictEqual(
        got.features?.map((feature) => feature.name),
        [],
      );
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("names the machine its paths are on, and nothing about how to reach it", () =>
    Effect.gen(function* () {
      // The doctrine's answer to a planner that needs to see uncommitted work on
      // another host: say which host. Going and looking is the operator's own
      // SSH config, which is theirs and not ours to hold — so this carries a
      // name and no credential, port, or user.
      yield* seed("hub", [HUB_PROJECT]);
      const got = yield* call("project_get", { slug: "hub" });

      assert.strictEqual(got.machine?.environmentId, "environment-1");
      assert.strictEqual(got.machine?.label, "simforge1");
      assert.strictEqual(got.machine?.platform.os, "linux");
      assert.isTrue(typeof got.machine?.hostname === "string" || got.machine?.hostname === null);
      assert.deepStrictEqual(Object.keys(got.machine ?? {}).toSorted(), [
        "environmentId",
        "hostname",
        "label",
        "platform",
      ]);
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );
});
