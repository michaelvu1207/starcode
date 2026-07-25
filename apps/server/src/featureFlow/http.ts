/**
 * Feature-flow HTTP route.
 *
 * @module FeatureFlowHttp
 */
import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { FeatureMapRegistry } from "../featureMap/FeatureMapRegistry.ts";
import { FeatureFlowService } from "./FeatureFlowService.ts";

export const featureFlowHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "featureFlow",
  Effect.fnUntraced(function* (handlers) {
    const featureFlow = yield* FeatureFlowService;
    const featureMap = yield* FeatureMapRegistry;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.featureFlow.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // The service already degrades a failed computation to an empty
          // snapshot with the reason logged, so there is no error path to map
          // here: a broken repository must not take out the whole panel.
          return yield* featureFlow.getSnapshot;
        }),
      )
      .handle(
        "map",
        Effect.fn("environment.featureFlow.map")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Same rule as the snapshot beside it: an unreadable registry is an
          // empty overlay, logged, not a failed request. The sky must still
          // render the work git can see.
          const entries = yield* featureMap.list.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not read the feature map; serving an empty overlay", {
                cause,
              }).pipe(Effect.as([])),
            ),
          );
          return { computedAt: DateTime.formatIso(yield* DateTime.now), entries };
        }),
      );
  }),
);
