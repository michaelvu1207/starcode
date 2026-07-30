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
} from "@starcode/contracts";
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
  THREAD_WAKE_PER_TURN_LIMIT,
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

describe("delivering a message to a thread on this machine", () => {
  const TARGET = ThreadId.make("thread-target");

  it("hands the text to the thread as a turn, verbatim", async () => {
    const { result, dispatched } = await run({}, (writer) =>
      writer.deliverMessage({
        callerThreadId: CALLER,
        threadId: TARGET,
        text: '<mailbox-messages count="1">…</mailbox-messages>',
      }),
    );

    expect(result._tag).toBe("Success");
    // One command, not the create/turn pair: the thread already exists.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe("thread.turn.start");
    expect(dispatched[0]?.threadId).toBe(TARGET);
    // The envelope reaches the thread unchanged. If this ever starts being
    // rewritten, the trust label the recipient reads is no longer the one the
    // mailbox wrote.
    const delivered = dispatched[0] as { message: { text: string; role: string } };
    expect(delivered.message.text).toBe('<mailbox-messages count="1">…</mailbox-messages>');
    expect(delivered.message.role).toBe("user");
  });

  it("stops a sender that keeps waking threads inside one turn", async () => {
    const { dispatched, layer } = harness({});
    const outcomes = await Effect.gen(function* () {
      const writer = yield* LocalThreadWriter;
      const results: Array<string> = [];
      for (let index = 0; index <= THREAD_WAKE_PER_TURN_LIMIT; index += 1) {
        results.push(
          yield* writer.deliverMessage({
            callerThreadId: CALLER,
            threadId: TARGET,
            text: `message ${index}`,
          }),
        );
      }
      return results;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(outcomes.filter((outcome) => outcome === "delivered")).toHaveLength(
      THREAD_WAKE_PER_TURN_LIMIT,
    );
    // Refused as a value rather than an error: the caller queues instead, so a
    // spent allowance must not read as a broken send.
    expect(outcomes.at(-1)).toBe("rate_limited");
    expect(dispatched).toHaveLength(THREAD_WAKE_PER_TURN_LIMIT);
  });

  it("gives the sender a fresh allowance on its next turn", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    // The turn key is read from the projection, so a caller cannot name its own
    // turn — this drives the reset the way the real thing does.
    let turn = "turn-1";
    const outcomes = await Effect.gen(function* () {
      const writer = yield* LocalThreadWriter;
      const results: Array<string> = [];
      for (let index = 0; index < THREAD_WAKE_PER_TURN_LIMIT; index += 1) {
        results.push(
          yield* writer.deliverMessage({ callerThreadId: CALLER, threadId: TARGET, text: "x" }),
        );
      }
      turn = "turn-2";
      results.push(
        yield* writer.deliverMessage({ callerThreadId: CALLER, threadId: TARGET, text: "x" }),
      );
      return results;
    }).pipe(
      Effect.provide(
        localThreadWriterLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(OrchestrationEngineService, {
                dispatch: (command: unknown) => {
                  dispatched.push(command as Record<string, unknown>);
                  return Effect.succeed({ sequence: dispatched.length });
                },
                streamDomainEvents: Effect.die("unused") as never,
                latestSequence: Effect.succeed(0),
              } as never),
              Layer.succeed(ProjectCatalogRegistry, { list: Effect.succeed([]) } as never),
              Layer.succeed(ProjectionSnapshotQuery, {
                getThreadShellById: () =>
                  Effect.succeed(Option.some({ latestTurn: { turnId: turn } })),
              } as never),
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );

    expect(outcomes.at(-1)).toBe("delivered");
  });

  it("keeps the wake and create budgets apart", async () => {
    const { layer } = harness({
      categories: [category({ bindings: ["project-atlas"] })],
      projects: [projectShell("project-atlas", selection("codex", "gpt-5.5"))],
    });

    const outcome = await Effect.gen(function* () {
      const writer = yield* LocalThreadWriter;
      // Spend the creation budget completely...
      for (let index = 0; index < LOCAL_THREAD_CREATE_PER_TURN_LIMIT; index += 1) {
        yield* writer.createThread({
          callerThreadId: CALLER,
          project: ProjectCategorySlug.make("atlas"),
          title: `helper ${index}`,
          message: "go",
        });
      }
      // ...and confirm the thread can still speak. A shared counter would mute
      // an orchestrator exactly when it had the most to tell the threads it
      // just started.
      return yield* writer.deliverMessage({
        callerThreadId: CALLER,
        threadId: TARGET,
        text: "status?",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(outcome).toBe("delivered");
  });
});

/**
 * Threads holding a conversation is the feature, so the thing worth pinning is
 * that nothing cuts one off. A depth cap used to live here and was removed: its
 * refusal downgraded the message to the mailbox, where an idle thread would not
 * read it until something else woke it — the exact defect immediate delivery
 * exists to remove, fired on the collaboration it was supposed to protect.
 */
describe("a conversation between two threads", () => {
  const chainHarness = () => {
    const dispatched: Array<Record<string, unknown>> = [];
    // Delivering to a thread starts a turn on it, and that new turn is what it
    // answers from. Modelling it matters: the per-turn allowance is scoped to a
    // turn, so a stub that pinned one turn per thread would make an ordinary
    // exchange look like one thread shouting six times.
    const turns = new Map<string, number>();
    const layer = localThreadWriterLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, {
            dispatch: (command: unknown) => {
              const typed = command as { type: string; threadId: string };
              dispatched.push(command as Record<string, unknown>);
              if (typed.type === "thread.turn.start") {
                turns.set(typed.threadId, (turns.get(typed.threadId) ?? 0) + 1);
              }
              return Effect.succeed({ sequence: dispatched.length });
            },
            streamDomainEvents: Effect.die("unused") as never,
            latestSequence: Effect.succeed(0),
          } as never),
          Layer.succeed(ProjectCatalogRegistry, { list: Effect.succeed([]) } as never),
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: (threadId: string) =>
              Effect.succeed(
                Option.some({
                  latestTurn: { turnId: `${threadId}-turn-${turns.get(threadId) ?? 0}` },
                }),
              ),
          } as never),
          NodeCrypto.layer,
        ),
      ),
    );
    return { dispatched, layer };
  };

  it("runs as long as the two threads have something to say", async () => {
    const { layer } = chainHarness();
    const a = ThreadId.make("thread-a");
    const b = ThreadId.make("thread-b");

    const outcomes = await Effect.gen(function* () {
      const writer = yield* LocalThreadWriter;
      const results: Array<string> = [];
      let sender = a;
      let target = b;
      // Twenty hops: far past anything a depth cap would have allowed, and an
      // ordinary length for a review or a debugging session. Each side speaks
      // once per turn, so no per-turn allowance is touched either.
      for (let hop = 0; hop < 20; hop += 1) {
        results.push(
          yield* writer.deliverMessage({ callerThreadId: sender, threadId: target, text: "ping" }),
        );
        [sender, target] = [target, sender];
      }
      return results;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(outcomes.every((outcome) => outcome === "delivered")).toBe(true);
  });

  it("still refuses a thread that fans out to everyone at once", async () => {
    const { layer } = chainHarness();
    const sender = ThreadId.make("thread-a");

    const outcomes = await Effect.gen(function* () {
      const writer = yield* LocalThreadWriter;
      const results: Array<string> = [];
      // Width is the exponential shape and stays bounded: this is what stops a
      // fan-out from outrunning the operator, and it is untouched by any of the
      // above.
      for (let index = 0; index <= THREAD_WAKE_PER_TURN_LIMIT; index += 1) {
        results.push(
          yield* writer.deliverMessage({
            callerThreadId: sender,
            threadId: ThreadId.make(`thread-target-${index}`),
            text: "ping",
          }),
        );
      }
      return results;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(outcomes.at(-1)).toBe("rate_limited");
  });
});

/**
 * The budget is the sender's, not the target machine's — so a thread cannot
 * spend it locally and then spend it again on every peer it knows. This is the
 * one guard left standing, and it was briefly not applied to the remote path at
 * all, which left the exponential case completely open across machines.
 */
it("charges one budget whether the target is local or on a peer", async () => {
  const { layer } = harness({});
  const caller = ThreadId.make("thread-caller");

  const outcomes = await Effect.gen(function* () {
    const writer = yield* LocalThreadWriter;
    const results: Array<boolean> = [];
    // Spend most of it locally...
    for (let index = 0; index < THREAD_WAKE_PER_TURN_LIMIT - 1; index += 1) {
      yield* writer.deliverMessage({
        callerThreadId: caller,
        threadId: ThreadId.make(`thread-local-${index}`),
        text: "ping",
      });
    }
    // ...and the remainder the way a peer wake does.
    results.push(yield* writer.chargeWakeAllowance(caller));
    results.push(yield* writer.chargeWakeAllowance(caller));
    return results;
  }).pipe(Effect.provide(layer), Effect.runPromise);

  expect(outcomes).toEqual([true, false]);
});
