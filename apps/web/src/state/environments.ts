import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { resolveConnectionDisplayName } from "../connection/connectionAlias";
import { useConnectionAlias, useConnectionAliases } from "../connection/connectionAliasStore";
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  /** What to show. The alias this client gave the connection, else `serverLabel`. */
  readonly label: string;
  /** The name the machine announces for itself, whether or not an alias hides it. */
  readonly serverLabel: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

/**
 * The one place an environment becomes a name. Every machine label in the app —
 * sidebar groups, settings rows, workbench chips, the composer's machine picker
 * — reads `label` off this projection, so teaching aliases here is what makes a
 * rename land everywhere at once instead of in twelve call sites.
 */
function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
  alias: string | null,
): EnvironmentPresentation {
  const serverLabel = presentation.entry.target.label;
  return {
    ...presentation,
    environmentId,
    label: resolveConnectionDisplayName(alias, serverLabel),
    serverLabel,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const aliasByEnvironmentId = useConnectionAliases();

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(
          environmentId,
          presentation,
          aliasByEnvironmentId[environmentId] ?? null,
        ),
      ),
    [aliasByEnvironmentId, presentationById],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const alias = useConnectionAlias(environmentId);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation, alias),
    [alias, environmentId, presentation],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentConnectionState(environmentId: EnvironmentId) {
  return useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
}
