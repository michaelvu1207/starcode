import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentUsageAtoms,
  createEnvironmentUsageSnapshotsAtom,
} from "@t3tools/client-runtime/state/usage";
import { useMemo } from "react";

import {
  buildAccountsUsageView,
  type AccountsUsageView,
} from "../components/usage/AccountsUsage.logic";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { environmentServerConfigsAtom } from "./server";

export const environmentUsage = createEnvironmentUsageAtoms(connectionAtomRuntime);

export const environmentUsageSnapshotsAtom = createEnvironmentUsageSnapshotsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotValueAtom: environmentUsage.snapshotValueAtom,
});

/**
 * Every connected machine's accounts and usage in one view. Each environment
 * is polled independently, so one unreachable machine costs that machine's
 * numbers and nothing else.
 */
export function useAccountsUsage(): AccountsUsageView {
  const { environments } = useEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const usageSnapshots = useAtomValue(environmentUsageSnapshotsAtom);

  return useMemo(
    () =>
      buildAccountsUsageView(
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          config: serverConfigs.get(environment.environmentId) ?? null,
          usage: usageSnapshots.get(environment.environmentId) ?? null,
        })),
      ),
    [environments, serverConfigs, usageSnapshots],
  );
}
