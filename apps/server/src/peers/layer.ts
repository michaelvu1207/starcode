/**
 * Peer federation composition root.
 *
 * Bundles the registry and reader so `server.ts` — one of the repo's hottest
 * files — carries a single `Layer.provide` for all of federation's services
 * instead of one per service. Adding a service here costs no diff there.
 *
 * @module PeersLayer
 */
import * as Layer from "effect/Layer";

import * as PeerRegistry from "./PeerRegistry.ts";
import * as PeerThreadReader from "./PeerThreadReader.ts";

export { peersHttpApiLayer } from "./http.ts";

export const PeerServicesLive = PeerThreadReader.layer.pipe(Layer.provideMerge(PeerRegistry.layer));
