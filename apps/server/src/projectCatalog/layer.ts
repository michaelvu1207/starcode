/**
 * Project catalog composition.
 *
 * Same rule as `peers/layer.ts` and `featureFlow/layer.ts`: new services in
 * this area are composed here so `server.ts` keeps one `Layer.provide` line,
 * and the permanent diff in a hot upstream file stays a single edit.
 *
 * @module ProjectCatalogLayer
 */
import * as ProjectCatalogRegistry from "./ProjectCatalogRegistry.ts";

export { projectCatalogHttpApiLayer } from "./http.ts";

export const ProjectCatalogServicesLive = ProjectCatalogRegistry.layer;
