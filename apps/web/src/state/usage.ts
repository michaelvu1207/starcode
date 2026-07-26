import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentUsageAtoms,
  createEnvironmentUsageSnapshotsAtom,
} from "@t3tools/client-runtime/state/usage";
import type { CliUsageModelAlias, CliUsageModelAliasCatalog, EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  buildAccountsUsageView,
  type AccountsUsageView,
} from "../components/usage/AccountsUsage.logic";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

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

/**
 * One machine's model-alias registry and the ids it will accept.
 *
 * `null` means the machine has not answered — an older server, or one still
 * loading — and the panel renders no assignment affordance at all rather than
 * an empty menu that would write over a mapping it never read.
 */
export function useUsageModelAliases(
  environmentId: EnvironmentId,
): CliUsageModelAliasCatalog | null {
  return useAtomValue(environmentUsage.modelAliasesValueAtom(environmentId));
}

export interface UsageModelAliasWriter {
  /**
   * Sets or removes one mapping, sending the machine's whole registry.
   *
   * Resolves once the write has landed and the reads that depend on it have
   * been asked to refetch: the server re-prices before it answers, so the
   * snapshot refresh right after is what makes the new dollars appear.
   */
  readonly assign: (input: {
    readonly provider: CliUsageModelAlias["provider"];
    readonly model: string;
    readonly pricedAs: string | null;
  }) => Promise<void>;
}

export function useUsageModelAliasWriter(environmentId: EnvironmentId): UsageModelAliasWriter {
  const catalog = useUsageModelAliases(environmentId);
  const setAliases = useAtomCommand(environmentUsage.setModelAliasesCommand);
  const refreshAliases = useAtomRefresh(environmentUsage.modelAliasesAtom(environmentId));
  const refreshSnapshot = useAtomRefresh(environmentUsage.snapshotAtom(environmentId));

  const assign = useCallback(
    async (input: {
      readonly provider: CliUsageModelAlias["provider"];
      readonly model: string;
      readonly pricedAs: string | null;
    }) => {
      // The registry is replaced whole, so an edit is "everything except this
      // model, plus the new row" — which makes removal the same operation.
      const existing = catalog?.aliases ?? [];
      const without = existing.filter(
        (alias) => !(alias.provider === input.provider && alias.model === input.model),
      );
      const next =
        input.pricedAs === null
          ? without
          : [
              ...without,
              { provider: input.provider, model: input.model, pricedAs: input.pricedAs },
            ];
      await setAliases({ environmentId, input: { aliases: next } });
      refreshAliases();
      refreshSnapshot();
    },
    [catalog, environmentId, refreshAliases, refreshSnapshot, setAliases],
  );

  return useMemo(() => ({ assign }), [assign]);
}
