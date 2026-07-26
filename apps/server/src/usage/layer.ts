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
import { layer as usageStoreLayer } from "./UsageStore.ts";

export { CliUsageStore } from "./cli/CliUsageStore.ts";
export { usageHttpApiLayer } from "./http.ts";
export { UsageStore } from "./UsageStore.ts";

export const UsageServicesLive = Layer.mergeAll(usageStoreLayer, cliUsageStoreLayer);
