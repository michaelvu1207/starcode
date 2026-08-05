/**
 * Feature-flow service composition.
 *
 * Same rule as `peers/layer.ts`: new services in this area are composed here so
 * `server.ts` keeps one `Layer.provide` line, and the permanent diff in a hot
 * upstream file stays a single edit.
 *
 * @module FeatureFlowLayer
 */
import * as Layer from "effect/Layer";

import * as FeatureMapRegistry from "../featureMap/FeatureMapRegistry.ts";
import * as FeatureFlowService from "./FeatureFlowService.ts";

export { featureFlowHttpApiLayer } from "./http.ts";

/**
 * The derived flow and the orchestrator's map ship as one layer.
 *
 * They are two halves of the same answer and they are consumed together by the
 * one HTTP group, so composing them here keeps `server.ts` at the single
 * `Layer.provide` line it already had — the fork discipline that keeps a
 * permanent diff out of a hot upstream file.
 */
export const FeatureFlowServicesLive = Layer.mergeAll(
  FeatureFlowService.layer,
  FeatureMapRegistry.layer,
);
