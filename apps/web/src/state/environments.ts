import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@starcode/client-runtime/connection";
import { Discovery } from "@starcode/client-runtime/relay";
import type { EnvironmentId } from "@starcode/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { isElectron } from "../env";
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
  /**
   * This client's OWN backend — the server the desktop app runs inside itself,
   * or a host-managed local backend it registered.
   *
   * Worth a field rather than a guess at the call site, because the two things
   * it distinguishes look identical: the desktop app's embedded server and the
   * paired hub on the same laptop announce the same machine name, so the picker
   * shows "seablue" twice and the wrong one is the one nothing else can see.
   * Threads created here are reachable only from this app — no browser client,
   * no other machine — so every list of connections has to say which is which.
   */
  readonly isOwnBackend: boolean;
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
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentPresentation {
  const serverLabel = presentation.entry.target.label;
  return {
    ...presentation,
    environmentId,
    label: resolveConnectionDisplayName(alias, serverLabel),
    serverLabel,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
    isOwnBackend: resolveIsOwnBackend(environmentId, presentation, primaryEnvironmentId),
  };
}

/**
 * Two shapes, one meaning: a server this app is hosting rather than one it
 * connected to.
 *
 * A host-managed secondary backend announces itself through the connection id
 * (`connection/desktopLocal.ts` owns that convention). The app's primary
 * backend does not — in the desktop app the primary environment simply IS the
 * embedded server, which is why this is gated on running under Electron: in a
 * browser the primary environment is whatever hub you pointed it at, and that
 * one is not private to anybody.
 */
function resolveIsOwnBackend(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
  primaryEnvironmentId: EnvironmentId | null,
): boolean {
  if (isDesktopLocalConnectionTarget(presentation.entry.target)) return true;
  return isElectron && primaryEnvironmentId !== null && environmentId === primaryEnvironmentId;
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const aliasByEnvironmentId = useConnectionAliases();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(
          environmentId,
          presentation,
          aliasByEnvironmentId[environmentId] ?? null,
          primaryEnvironmentId,
        ),
      ),
    [aliasByEnvironmentId, presentationById, primaryEnvironmentId],
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
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation, alias, primaryEnvironmentId),
    [alias, environmentId, presentation, primaryEnvironmentId],
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
