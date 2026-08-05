/**
 * Peer federation composition root.
 *
 * Bundles the fleet services with the one-release peer-registry view.
 *
 * @module PeersLayer
 */
import * as Layer from "effect/Layer";

import * as FleetRegistry from "../fleet/FleetRegistry.ts";
import * as FleetReconciler from "../fleet/FleetReconciler.ts";
import * as FleetReconcileLoop from "../fleet/FleetReconcileLoop.ts";
import * as FleetClientBootstrapCache from "../fleet/FleetClientBootstrapCache.ts";
import * as FleetThreadIndex from "../fleet/FleetThreadIndex.ts";
import * as PeerRegistry from "./PeerRegistry.ts";

export { fleetHttpApiLayer } from "../fleet/http.ts";
export { peersHttpApiLayer } from "./http.ts";

const FleetCoreLive = FleetReconciler.layer.pipe(
  Layer.provideMerge(FleetRegistry.layer),
  Layer.provideMerge(FleetClientBootstrapCache.layer),
  Layer.provideMerge(FleetThreadIndex.layer),
);
const FleetServicesLive = FleetReconcileLoop.layer.pipe(Layer.provideMerge(FleetCoreLive));
const PeerRegistryLive = PeerRegistry.layer.pipe(Layer.provideMerge(FleetServicesLive));

export const PeerServicesLive = PeerRegistryLive;
