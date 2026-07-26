/**
 * Usage HTTP route.
 *
 * Read-only and polled: live push would need a new WS RPC method, and the RPC
 * group is a single ~70-argument positional call that conflicts on every
 * upstream merge. Rate limits move on the order of minutes and spend is a
 * running total, so a poll loses nothing but immediacy.
 *
 * @module UsageHttp
 */
import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { CliUsageStore } from "./cli/CliUsageStore.ts";
import { UsageStore } from "./UsageStore.ts";

export const usageHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "usage",
  Effect.fnUntraced(function* (handlers) {
    const usageStore = yield* UsageStore;
    const cliUsageStore = yield* CliUsageStore;

    return handlers.handle(
      "snapshot",
      Effect.fn("environment.usage.snapshot")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        const snapshot = yield* usageStore
          .getSnapshot()
          .pipe(Effect.catch((cause) => failEnvironmentInternal("usage_snapshot_failed", cause)));
        // Historical CLI usage is read from a background aggregate that answers
        // instantly, so it cannot delay the live figures and a failure to
        // compute it degrades to a null field rather than a failed request.
        const cliHistory = yield* cliUsageStore.current;
        return { ...snapshot, cliHistory };
      }),
    );
  }),
);
