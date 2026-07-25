/**
 * Terminal history composition root.
 *
 * Mirrors `usage/layer.ts` and `peers/layer.ts`: one export for `server.ts` to
 * provide, so adding a service here costs no further diff in one of the repo's
 * hottest files.
 *
 * @module HistoryLayer
 */
export { HistoryIndex, layer as HistoryServicesLive } from "./HistoryIndex.ts";
export { historyHttpApiLayer } from "./http.ts";
