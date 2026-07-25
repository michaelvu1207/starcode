/**
 * Terminal history composition root.
 *
 * Mirrors `usage/layer.ts` and `peers/layer.ts`: one export for `server.ts` to
 * provide, so adding a service here costs no further diff in one of the repo's
 * hottest files.
 *
 * @module HistoryLayer
 */
import * as Layer from "effect/Layer";

import { layer as historyIndexLayer } from "./HistoryIndex.ts";
import { layer as historyImportRegistryLayer } from "./importRegistry.ts";

export { HistoryIndex } from "./HistoryIndex.ts";
export { HistoryImportRegistry } from "./importRegistry.ts";
export { historyHttpApiLayer } from "./http.ts";

export const HistoryServicesLive = Layer.mergeAll(historyIndexLayer, historyImportRegistryLayer);
