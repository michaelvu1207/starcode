import { Connection } from "@starcode/client-runtime/connection";
import {
  featureFlowSnapshotLoaderLayer,
  featureMapSnapshotLoaderLayer,
} from "@starcode/client-runtime/state/feature-flow";
import { projectCatalogLoaderLayer } from "@starcode/client-runtime/state/project-catalog";
import { shellSnapshotLoaderLayer } from "@starcode/client-runtime/state/shell";
import { terminalHistoryLoaderLayer } from "@starcode/client-runtime/state/terminal-history";
import { threadSnapshotLoaderLayer } from "@starcode/client-runtime/state/threads";
import { usageSnapshotLoaderLayer } from "@starcode/client-runtime/state/usage";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import { connectionPlatformLayer } from "./platform";
import { fleetOnboardingGatewayLayer, fleetOnboardingPlatformLayer } from "./fleetOnboarding";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);
const providedClientPlatformLayer = Layer.merge(
  providedConnectionPlatformLayer,
  fleetOnboardingPlatformLayer,
);

const snapshotLoaderLayer = Layer.mergeAll(
  threadSnapshotLoaderLayer,
  shellSnapshotLoaderLayer,
  usageSnapshotLoaderLayer,
  terminalHistoryLoaderLayer,
  featureFlowSnapshotLoaderLayer,
  featureMapSnapshotLoaderLayer,
  projectCatalogLoaderLayer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof fleetOnboardingPlatformLayer
  | typeof fleetOnboardingGatewayLayer;

const baseConnectionLayer = Layer.merge(Connection.layer, snapshotLoaderLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedClientPlatformLayer)),
);
const connectionLayer = fleetOnboardingGatewayLayer.pipe(Layer.provideMerge(baseConnectionLayer));

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
