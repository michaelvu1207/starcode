/**
 * The orchestrator's round trip, through the handlers an agent actually calls.
 *
 * `McpMasterGating.test` covers the structural half — that an ordinary session's
 * credential never carries the capability at all. This covers the half that
 * runs afterwards: the handler refuses without it, performs the work with it,
 * and what the tools write is what the sky later reads.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  FeatureMapError,
  ProviderInstanceId,
  ThreadId,
  type FeatureMapEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";
import {
  FeatureMapRegistry,
  layer as featureMapRegistryLayer,
} from "../../../featureMap/FeatureMapRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-master"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const makeLayer = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext)(invocation(capabilities)).pipe(
    Layer.provideMerge(featureMapRegistryLayer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-feature-tools-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const MASTER = ["preview", "peers", "peers-operate", "features-operate"] as const;
const WORKER = ["preview", "peers"] as const;

/**
 * Every tool returns one of these shapes. Named rather than left as `unknown`
 * so flipping a call to assert on its refusal does not put `unknown` in an
 * error channel.
 */
interface ToolResult {
  readonly entry?: FeatureMapEntry;
  readonly entries?: ReadonlyArray<FeatureMapEntry>;
  readonly removedCount?: number;
}

/** Calls one tool's handler directly — the same function MCP dispatches to. */
const call = (
  name: keyof typeof __testing.handlers,
  input: unknown,
): Effect.Effect<
  ToolResult,
  FeatureMapError,
  McpInvocationContext.McpInvocationContext | FeatureMapRegistry
> =>
  (
    __testing.handlers[name] as (
      value: unknown,
    ) => Effect.Effect<
      ToolResult,
      FeatureMapError,
      McpInvocationContext.McpInvocationContext | FeatureMapRegistry
    >
  )(input);

describe("feature map tools", () => {
  it.effect("refuses every write from a session that is not the orchestrator", () =>
    Effect.gen(function* () {
      for (const tool of ["feature_create", "feature_promote", "feature_plan_set"] as const) {
        const refused = yield* call(tool, {
          name: "Nope",
          id: "aaaaaaaaaaaa",
          features: [],
        }).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "capability_unavailable");
      }
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("lets every session read the map, so an agent can orient itself", () =>
    Effect.gen(function* () {
      const listed = yield* call("feature_map_list", {});
      assert.deepEqual([...(listed.entries ?? [])], []);
    }).pipe(Effect.provide(makeLayer(WORKER))),
  );

  it.effect("creates, links, promotes, and hands the sky back what it wrote", () =>
    Effect.gen(function* () {
      const base = (yield* call("feature_create", {
        name: "Terminal history reader",
        description: "The index the import picker reads.",
      })).entry!;
      const stacked = (yield* call("feature_create", {
        name: "Conversation import",
        threadId: "thread-import",
      })).entry!;

      assert.strictEqual(base.stage, "in-progress");
      assert.strictEqual(stacked.planned, false);
      assert.strictEqual(stacked.threadId, "thread-import");

      yield* call("feature_link", { id: stacked.id, dependsOnId: base.id });
      const promoted = (yield* call("feature_promote", { id: base.id })).entry!;
      assert.strictEqual(promoted.stage, "in-dev");

      // What the sky reads is the registry, so read it the way the HTTP route
      // does rather than trusting the tool results.
      const registry = yield* FeatureMapRegistry;
      const entries = yield* registry.list;
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      assert.strictEqual(byName.get("Terminal history reader")!.stage, "in-dev");
      assert.deepEqual(
        [...byName.get("Conversation import")!.dependsOn],
        [byName.get("Terminal history reader")!.id],
      );
    }).pipe(Effect.provide(makeLayer(MASTER))),
  );

  it.effect("lays out a plan as ghosts and leaves work under way alone", () =>
    Effect.gen(function* () {
      const real = (yield* call("feature_create", {
        name: "Under way",
        threadId: "thread-1",
      })).entry!;

      const plan = yield* call("feature_plan_set", {
        features: [
          { key: "one", name: "Desktop rebuild pipeline" },
          { key: "two", name: "Sky on mobile", dependsOn: ["one"] },
        ],
      });

      assert.strictEqual(plan.entries!.length, 2);
      assert.isTrue(plan.entries!.every((entry) => entry.planned));

      const registry = yield* FeatureMapRegistry;
      const entries = yield* registry.list;
      assert.deepEqual([...entries].map((entry) => entry.name).toSorted(), [
        "Desktop rebuild pipeline",
        "Sky on mobile",
        "Under way",
      ]);
      assert.isTrue(entries.find((entry) => entry.id === real.id)!.planned === false);
    }).pipe(Effect.provide(makeLayer(MASTER))),
  );
});
