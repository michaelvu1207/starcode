/**
 * Feature-flow HTTP route.
 *
 * @module FeatureFlowHttp
 */
import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { FeatureFlowService } from "./FeatureFlowService.ts";

export const featureFlowHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "featureFlow",
  Effect.fnUntraced(function* (handlers) {
    const featureFlow = yield* FeatureFlowService;

    return handlers.handle(
      "snapshot",
      Effect.fn("environment.featureFlow.snapshot")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        // The service already degrades a failed computation to an empty
        // snapshot with the reason logged, so there is no error path to map
        // here: a broken repository must not take out the whole panel.
        return yield* featureFlow.getSnapshot;
      }),
    );
  }),
);
