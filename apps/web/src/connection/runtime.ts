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

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
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
  | typeof connectionPlatformLayer;

const connectionLayer = Layer.merge(Connection.layer, snapshotLoaderLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedConnectionPlatformLayer)),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
