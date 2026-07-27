/**
 * Starting a thread on this machine.
 *
 * Two things worth pinning. The placement refusals are inherited wholesale from
 * the peer path, so these assert the local writer actually routes through them
 * rather than quietly picking a folder — the failure they prevent (work filed
 * in a checkout nobody named) is invisible from inside the call that caused it.
 *
 * And the per-turn cap, which is the only thing standing between an ungated
 * `thread_create` and a fan-out that eats the machine. It has to hold *and* it
 * has to let go: a cap that never reset would turn a long-lived orchestrator
 * into one that can delegate three times and then never again.
 */
import {
  ProjectCategorySlug,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadToolError,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ProjectCategoryDefaults,
  type ProjectCategoryRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";
import {
  LOCAL_THREAD_CREATE_PER_TURN_LIMIT,
  LocalThreadWriter,
  layer as localThreadWriterLayer,
} from "./LocalThreadWriter.ts";

const isThreadToolError = Schema.is(ThreadToolError);

const CALLER = ThreadId.make("thread-caller");

const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const category = (input: {
  readonly slug?: string;
  readonly bindings?: ReadonlyArray<string>;
  readonly defaults?: ProjectCategoryDefaults;
}): ProjectCategoryRecord =>
  ({
    slug: ProjectCategorySlug.make(input.slug ?? "atlas"),
    createdAt: "2026-07-01T00:00:00.000Z",
    display: {
      title: "Atlas",
      summary: "",
      accent: "",
      glyph: "",
      icon: "",
      parentSlug: null,
      links: [],
      notes: "",
      archivedAt: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
    local: {
      bindings: (input.bindings ?? []).map((projectId) => ({
        projectId: ProjectId.make(projectId),
        boundAt: "2026-07-01T00:00:00.000Z",
      })),
      threadIds: [],
      excludedThreadIds: [],
      masterThreadId: "",
      masterDefaults: { runtimeMode: "approval-required", interactionMode: "plan" },
      defaults: input.defaults ?? {},
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  }) as ProjectCategoryRecord;

const projectShell = (
  id: string,
  defaultModelSelection: ModelSelection | null,
): OrchestrationProjectShell =>
  ({
    id: ProjectId.make(id),
    title: "Atlas",
    workspaceRoot: `/repo/${id}`,
    defaultModelSelection,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  }) as OrchestrationProjectShell;

interface Harness {
  readonly categories?: ReadonlyArray<ProjectCategoryRecord>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  /** What the caller's live turn is, which is what the cap keys on. */
  readonly turnId?: string | null;
}

/**
 * Collects dispatched commands so a test can assert the pair and its order,
 * which is the part that would silently break if someone "simplified" the two
 * dispatches into one bootstrap command the engine cannot unpack.
 */
const harness = (input: Harness = {}) => {
  const dispatched: Array<Record<string, unknown>> = [];

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: unknown) => {
      dispatched.push(command as Record<string, unknown>);
      return Effect.succeed({ sequence: dispatched.length });
    },
    streamDomainEvents: Effect.die("unused") as never,
    latestSequence: Effect.succeed(0),
  } as never);

  const catalogLayer = Layer.succeed(ProjectCatalogRegistry, {
    list: Effect.succeed(input.categories ?? []),
    find: () => Effect.die("unused"),
    upsert: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    fileThread: () => Effect.die("unused"),
  } as never);

  const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: (projectId: string) => {
      const found = (input.projects ?? []).find((project) => project.id === projectId);
      return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
    },
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () =>
      Effect.succeed(
        input.turnId === null
          ? Option.none()
          : Option.some({ latestTurn: { turnId: input.turnId ?? "turn-1" } }),
      ),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
  } as never);

  // Crypto is real rather than stubbed: the ids it generates are opaque to
  // every assertion here, and a fake would only add a way for the stub to drift
  // from the service.
  const layer = localThreadWriterLayer.pipe(
    Layer.provide(Layer.mergeAll(engineLayer, catalogLayer, projectionLayer, NodeCrypto.layer)),
  );

  return { dispatched, layer };
};

const run = <A>(
  input: Harness,
  program: (writer: LocalThreadWriter["Service"]) => Effect.Effect<A, ThreadToolError>,
) => {
  const { dispatched, layer } = harness(input);
  return Effect.gen(function* () {
    const writer = yield* LocalThreadWriter;
    const result = yield* Effect.result(program(writer));
    return { result, dispatched };
  }).pipe(Effect.provide(layer), Effect.runPromise);
};

const create = (writer: LocalThreadWriter["Service"], overrides: Record<string, unknown> = {}) =>
  writer.createThread({
    callerThreadId: CALLER,
    project: ProjectCategorySlug.make("atlas"),
    title: "Worker",
    message: "Do the thing.",
    ...overrides,
  } as never);

describe("LocalThreadWriter.createThread", () => {
  it("creates the thread and starts its first turn, in that order", async () => {
    const { result, dispatched } = await run(
      {
        categories: [category({ bindings: ["p-1"] })],
        projects: [projectShell("p-1", selection("claude", "claude-opus-5"))],
      },
      (writer) => create(writer),
    );

    expect(result._tag).toBe("Success");
    // The pair, and the order. `thread.turn.start` first would be rejected by
    // the decider — the thread would not exist yet.
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    const [created, started] = dispatched;
    expect(created?.projectId).toBe("p-1");
    expect(created?.title).toBe("Worker");
    expect(created?.modelSelection).toEqual(selection("claude", "claude-opus-5"));
    // Same thread on both commands, or the turn lands on nothing.
    expect(started?.threadId).toBe(created?.threadId);
    expect((started?.message as { text: string } | undefined)?.text).toBe("Do the thing.");
  });

  it("lets the project's own default beat the folder's", async () => {
    const { result, dispatched } = await run(
      {
        categories: [
          category({
            bindings: ["p-1"],
            defaults: { modelSelection: selection("codex", "gpt-5.6") },
          }),
        ],
        projects: [projectShell("p-1", selection("claude", "claude-opus-5"))],
      },
      (writer) => create(writer),
    );

    expect(result._tag).toBe("Success");
    expect(dispatched[0]?.modelSelection).toEqual(selection("codex", "gpt-5.6"));
  });

  it("refuses a project that binds no folder rather than inventing one", async () => {
    const { result, dispatched } = await run(
      { categories: [category({ bindings: [] })] },
      (writer) => create(writer),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && isThreadToolError(result.failure)) {
      expect(result.failure.reason).toBe("project_not_found");
      expect(result.failure.detail).toContain("binds no folder");
    }
    expect(dispatched).toHaveLength(0);
  });

  it("refuses to guess between several folders", async () => {
    const { result } = await run(
      { categories: [category({ bindings: ["p-1", "p-2"] })] },
      (writer) => create(writer),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && isThreadToolError(result.failure)) {
      expect(result.failure.reason).toBe("project_not_found");
      // The caller is told what to pass instead, not just that it failed.
      expect(result.failure.detail).toContain("p-1");
      expect(result.failure.detail).toContain("p-2");
    }
  });

  it("names the projects it does know when the slug is unknown", async () => {
    const { result } = await run(
      { categories: [category({ slug: "atlas", bindings: ["p-1"] })] },
      (writer) => create(writer, { project: ProjectCategorySlug.make("nowhere") }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && isThreadToolError(result.failure)) {
      expect(result.failure.reason).toBe("project_not_found");
      expect(result.failure.detail).toContain("atlas");
    }
  });

  it("reports an unconfigured model as the configuration problem it is", async () => {
    const { result, dispatched } = await run(
      {
        categories: [category({ bindings: ["p-1"] })],
        projects: [projectShell("p-1", null)],
      },
      (writer) => create(writer),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && isThreadToolError(result.failure)) {
      expect(result.failure.reason).toBe("model_unavailable");
    }
    // Refused before dispatching a half-formed command.
    expect(dispatched).toHaveLength(0);
  });

  it("caps how many threads one caller may start in a single turn", async () => {
    const { dispatched, layer } = harness({
      categories: [category({ bindings: ["p-1"] })],
      projects: [projectShell("p-1", selection("claude", "claude-opus-5"))],
    });

    const outcomes = await Effect.gen(function* () {
      const writer = yield* LocalThreadWriter;
      const results = [];
      for (let attempt = 0; attempt < LOCAL_THREAD_CREATE_PER_TURN_LIMIT + 1; attempt++) {
        results.push(yield* Effect.result(create(writer)));
      }
      return results;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(outcomes.slice(0, LOCAL_THREAD_CREATE_PER_TURN_LIMIT).map((r) => r._tag)).toEqual(
      Array.from({ length: LOCAL_THREAD_CREATE_PER_TURN_LIMIT }, () => "Success"),
    );
    const refused = outcomes.at(-1);
    expect(refused?._tag).toBe("Failure");
    if (refused?._tag === "Failure" && isThreadToolError(refused.failure)) {
      expect(refused.failure.reason).toBe("rate_limited");
    }
    // The refusal costs nothing: it is charged before any service read, so the
    // over-limit call dispatches no commands at all.
    expect(dispatched).toHaveLength(LOCAL_THREAD_CREATE_PER_TURN_LIMIT * 2);
  });

  it("gives the caller a fresh allowance on its next turn", async () => {
    // A cap that never reset would let an orchestrator delegate three times and
    // then be permanently unable to start work again.
    let turnId = "turn-1";
    const { layer } = harness({
      categories: [category({ bindings: ["p-1"] })],
      projects: [projectShell("p-1", selection("claude", "claude-opus-5"))],
      get turnId() {
        return turnId;
      },
    });

    const outcome = await Effect.gen(function* () {
      const writer = yield* LocalThreadWriter;
      for (let attempt = 0; attempt < LOCAL_THREAD_CREATE_PER_TURN_LIMIT; attempt++) {
        yield* Effect.result(create(writer));
      }
      const blocked = yield* Effect.result(create(writer));
      turnId = "turn-2";
      const afterNewTurn = yield* Effect.result(create(writer));
      return { blocked, afterNewTurn };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(outcome.blocked._tag).toBe("Failure");
    expect(outcome.afterNewTurn._tag).toBe("Success");
  });
});
