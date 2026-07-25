import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentFeatureFlowAtoms,
  createEnvironmentFeatureFlowSnapshotsAtom,
} from "@t3tools/client-runtime/state/feature-flow";
import { useMemo } from "react";

import {
  buildFeatureFlowView,
  type FeatureFlowView,
} from "../components/workbench/FeatureFlow.model";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { environmentServerConfigsAtom } from "./server";

export const environmentFeatureFlow = createEnvironmentFeatureFlowAtoms(connectionAtomRuntime);

export const environmentFeatureFlowSnapshotsAtom = createEnvironmentFeatureFlowSnapshotsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotValueAtom: environmentFeatureFlow.snapshotValueAtom,
});

/**
 * Every connected machine's feature flow, composed into per-project pipelines.
 *
 * Two independent absence signals feed the view, and they mean different
 * things. A machine that is not connected is pending: it has not been asked
 * yet, and naming it would blame it for the network. A machine that *is*
 * connected and does not advertise the capability is unsupported, and the panel
 * names it — a mixed fleet mid-rollout is a normal state that must be visible.
 *
 * Note what the connected case deliberately does not require: a decoded
 * `ServerConfig`. Keying "pending" off a missing descriptor was the first
 * version of this, and a machine whose descriptor never arrived then vanished
 * from the panel entirely — observed live against a server predating these
 * routes. Silence about a machine you are connected to is the one answer this
 * panel must never give.
 */
export function useFeatureFlowView(masterThreadKey: string | null): FeatureFlowView {
  const { environments } = useEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const snapshots = useAtomValue(environmentFeatureFlowSnapshotsAtom);

  return useMemo(
    () =>
      buildFeatureFlowView(
        environments.map((environment) => {
          const config = serverConfigs.get(environment.environmentId) ?? null;
          return {
            environmentId: environment.environmentId,
            label: environment.label,
            snapshot: snapshots.get(environment.environmentId) ?? null,
            supported: config?.environment.capabilities.featureFlow === true,
            pending: environment.connection.phase !== "connected",
          };
        }),
        { excludeThreadKey: masterThreadKey },
      ),
    [environments, masterThreadKey, serverConfigs, snapshots],
  );
}
