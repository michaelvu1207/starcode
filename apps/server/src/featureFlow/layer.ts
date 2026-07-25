/**
 * Feature-flow service composition.
 *
 * Same rule as `peers/layer.ts`: new services in this area are composed here so
 * `server.ts` keeps one `Layer.provide` line, and the permanent diff in a hot
 * upstream file stays a single edit.
 *
 * @module FeatureFlowLayer
 */
import * as FeatureFlowService from "./FeatureFlowService.ts";

export { featureFlowHttpApiLayer } from "./http.ts";

export const FeatureFlowServicesLive = FeatureFlowService.layer;
