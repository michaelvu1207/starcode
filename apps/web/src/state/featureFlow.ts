import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentFeatureFlowAtoms,
  createEnvironmentFeatureFlowSnapshotsAtom,
  createEnvironmentFeatureMapAtoms,
  createEnvironmentFeatureMapSnapshotsAtom,
} from "@t3tools/client-runtime/state/feature-flow";
import { useMemo } from "react";

import {
  buildFeatureFlowView,
  type FeatureFlowView,
} from "../components/workbench/FeatureFlow.model";
import type { SkyMachineMap } from "../components/workbench/StarMap.model";
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
export function useFeatureFlowView(
  masterThreadKey: string | null,
  /** Scopes the view to one project. Omit for the fleet-wide `/workbench` sky. */
  includeThreadKey?: ((key: string) => boolean) | null,
): FeatureFlowView {
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
        { excludeThreadKey: masterThreadKey, includeThreadKey: includeThreadKey ?? null },
      ),
    [environments, includeThreadKey, masterThreadKey, serverConfigs, snapshots],
  );
}

export const environmentFeatureMap = createEnvironmentFeatureMapAtoms(connectionAtomRuntime);

export const environmentFeatureMapSnapshotsAtom = createEnvironmentFeatureMapSnapshotsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotValueAtom: environmentFeatureMap.snapshotValueAtom,
});

/**
 * Every connected machine's feature map, keyed by the machine that served it.
 *
 * Kept per-machine rather than flattened because an entry's thread id is only
 * meaningful on the server that wrote it — the same reasoning that keeps
 * feature-flow dependencies from resolving across machines. The sky itself is
 * connection-independent; this is the one place the origin of a row still
 * matters, and it stops here.
 */
export function useFeatureMapByEnvironment(): ReadonlyMap<string, SkyMachineMap> {
  const { environments } = useEnvironments();
  const snapshots = useAtomValue(environmentFeatureMapSnapshotsAtom);

  return useMemo(() => {
    const byEnvironment = new Map<string, SkyMachineMap>();
    for (const environment of environments) {
      const snapshot = snapshots.get(environment.environmentId);
      // A machine that answered with nothing is kept, with an empty list. It
      // used to be dropped alongside the machines that did not answer at all,
      // which made the two indistinguishable downstream — and a caller that
      // cannot tell them apart ends up asserting "no features here" about a
      // machine it never heard from. Unavailable is not empty (invariant 12).
      if (snapshot === undefined) continue;
      byEnvironment.set(environment.environmentId, {
        label: environment.label,
        entries: snapshot.entries,
      });
    }
    return byEnvironment;
  }, [environments, snapshots]);
}
