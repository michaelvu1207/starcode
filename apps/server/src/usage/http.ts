/**
 * Usage HTTP routes.
 *
 * The snapshot is read-only and polled: live push would need a new WS RPC
 * method, and the RPC group is a single ~70-argument positional call that
 * conflicts on every upstream merge. Rate limits move on the order of minutes
 * and spend is a running total, so a poll loses nothing but immediacy.
 *
 * The model-alias routes are the one write here, and they stay on HTTP for the
 * same reason — a settings-shaped edit made a few times in a machine's life
 * does not justify touching the RPC group.
 *
 * @module UsageHttp
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type CliUsageModelAliasCatalog,
  type CliUsageProvider,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { CliUsageStore } from "./cli/CliUsageStore.ts";
import { CliUsageModelAliasRegistry } from "./cli/modelAliasRegistry.ts";
import { priceableModels } from "./cli/pricing.ts";
import { UsageStore } from "./UsageStore.ts";

/** Fixed at build time — it is the vendored rate table's key set. */
const PRICEABLE: CliUsageModelAliasCatalog["priceable"] = (
  ["claude", "codex"] satisfies ReadonlyArray<CliUsageProvider>
).map((provider) => ({ provider, models: priceableModels(provider) }));

export const usageHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "usage",
  Effect.fnUntraced(function* (handlers) {
    const usageStore = yield* UsageStore;
    const cliUsageStore = yield* CliUsageStore;
    const aliasRegistry = yield* CliUsageModelAliasRegistry;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.usage.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* usageStore
            .getSnapshot()
            .pipe(Effect.catch((cause) => failEnvironmentInternal("usage_snapshot_failed", cause)));
          // Historical CLI usage is read from a background aggregate that
          // answers instantly, so it cannot delay the live figures and a
          // failure to compute it degrades to a null field rather than a
          // failed request.
          const cliHistory = yield* cliUsageStore.current;
          return { ...snapshot, cliHistory };
        }),
      )
      .handle(
        "modelAliases",
        Effect.fn("environment.usage.modelAliases")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const aliases = yield* aliasRegistry.list.pipe(
            Effect.catch((cause) => failEnvironmentInternal("usage_model_aliases_failed", cause)),
          );
          return { aliases, priceable: PRICEABLE };
        }),
      )
      .handle(
        "setModelAliases",
        Effect.fn("environment.usage.setModelAliases")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const aliases = yield* aliasRegistry
            .replace(args.payload.aliases)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("usage_model_aliases_save_failed", cause),
              ),
            );
          // Re-price before answering, so the next snapshot poll — which the
          // panel fires immediately after this returns — already reflects the
          // edit. It re-folds what is in memory; nothing is re-read from disk.
          yield* cliUsageStore.reprice;
          return { aliases, priceable: PRICEABLE };
        }),
      );
  }),
);
