/**
 * Handlers for the feature-map tools.
 *
 * @module FeatureMapHandlers
 */
import { FeatureMapError, type FeatureMapOperation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { FeatureMapRegistry } from "../../../featureMap/FeatureMapRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FeatureMapToolkit } from "./tools.ts";

/**
 * The master gate, and — as with the peer write tools — the second line of
 * defence rather than the first. A non-master session's credential never
 * carries `features-operate`, so this only fires for a token minted with it and
 * then reused. Stating the invariant in the path that depends on it means the
 * gate cannot be lost to a refactor of the mint site.
 */
const requireOperate = (operation: FeatureMapOperation) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("features-operate")) {
      return yield* new FeatureMapError({
        operation,
        reason: "capability_unavailable",
        detail:
          "Only the designated workbench master thread may change the feature map. Read it with feature_map_list.",
      });
    }
    return invocation;
  });

const handlers = {
  feature_map_list: (input) =>
    Effect.gen(function* () {
      const registry = yield* FeatureMapRegistry;
      const entries = yield* registry.list;
      return {
        entries: input.includePlanned === false ? entries.filter((e) => !e.planned) : entries,
      };
    }),
  feature_create: (input) =>
    Effect.gen(function* () {
      yield* requireOperate("create");
      const registry = yield* FeatureMapRegistry;
      return { entry: yield* registry.create(input) };
    }),
  feature_update: (input) =>
    Effect.gen(function* () {
      yield* requireOperate("update");
      const registry = yield* FeatureMapRegistry;
      return { entry: yield* registry.update(input) };
    }),
  feature_promote: (input) =>
    Effect.gen(function* () {
      yield* requireOperate("promote");
      const registry = yield* FeatureMapRegistry;
      return { entry: yield* registry.promote(input) };
    }),
  feature_link: (input) =>
    Effect.gen(function* () {
      yield* requireOperate("link");
      const registry = yield* FeatureMapRegistry;
      return { entry: yield* registry.link(input) };
    }),
  feature_plan_set: (input) =>
    Effect.gen(function* () {
      yield* requireOperate("plan_set");
      const registry = yield* FeatureMapRegistry;
      return yield* registry.planSet(input);
    }),
} satisfies Parameters<typeof FeatureMapToolkit.toLayer>[0];

export const FeatureMapToolkitHandlersLive = FeatureMapToolkit.toLayer(handlers);

/**
 * The handler map, for tests that want to call a tool the way MCP does without
 * standing up the streaming toolkit runtime around it. Same functions the layer
 * above registers — the gate under test is inside them, not around them.
 */
export const __testing = { handlers };
