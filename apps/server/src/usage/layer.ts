/**
 * Usage composition root.
 *
 * Mirrors `peers/layer.ts`: one export for `server.ts` to provide, so adding a
 * service here costs no diff in one of the repo's hottest files.
 *
 * @module UsageLayer
 */
import * as Layer from "effect/Layer";

import { layer as cliUsageStoreLayer } from "./cli/CliUsageStore.ts";
import { layer as modelAliasRegistryLayer } from "./cli/modelAliasRegistry.ts";
import { layer as usageStoreLayer } from "./UsageStore.ts";

export { CliUsageStore } from "./cli/CliUsageStore.ts";
export { CliUsageModelAliasRegistry } from "./cli/modelAliasRegistry.ts";
export { usageHttpApiLayer } from "./http.ts";
export { UsageStore } from "./UsageStore.ts";

/**
 * The alias registry is merged as well as provided: the HTTP group reads it
 * directly to serve and replace the mapping, and the usage store reads it to
 * price with. One instance, two consumers.
 */
export const UsageServicesLive = Layer.mergeAll(usageStoreLayer, cliUsageStoreLayer).pipe(
  Layer.provideMerge(modelAliasRegistryLayer),
);
