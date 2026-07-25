/**
 * Where a connection's alias lives.
 *
 * Aliases are per client, not per account: they are stored beside the other
 * per-client display preferences in localStorage rather than in the IndexedDB
 * connection catalog. Two reasons, and the second is the load-bearing one.
 *
 * 1. The catalog's targets are reconciled from the host — the desktop bootstrap
 *    rewrites local targets on every launch, relay discovery rewrites relay
 *    ones — so a name written into a target would be silently overwritten by
 *    the next reconcile. An alias has to outlive its target.
 * 2. localStorage is synchronous, so the alias is known on first paint. The
 *    catalog loads asynchronously; storing aliases there would render every
 *    machine under its server name for a frame and then rename it.
 *
 * Nothing here reaches the server, so a rename works against any server
 * version and does not need the far machine to be reachable at all.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";
import { normalizeConnectionAlias, sanitizeConnectionAliases } from "./connectionAlias";

export const CONNECTION_ALIAS_STORAGE_KEY = "t3code:connection-aliases:v1";

interface ConnectionAliasStoreState {
  /** `environmentId -> alias`. An environment with no entry uses its server label. */
  aliasByEnvironmentId: Record<string, string>;
  /** Empty or whitespace-only input clears the alias rather than storing a blank name. */
  setConnectionAlias: (environmentId: string, alias: string) => void;
  clearConnectionAlias: (environmentId: string) => void;
}

export const useConnectionAliasStore = create<ConnectionAliasStoreState>()(
  persist(
    (set) => ({
      aliasByEnvironmentId: {},
      setConnectionAlias: (environmentId, alias) =>
        set((state) => {
          const normalized = normalizeConnectionAlias(alias);
          if (normalized === null) {
            if (!(environmentId in state.aliasByEnvironmentId)) return state;
            const { [environmentId]: _cleared, ...rest } = state.aliasByEnvironmentId;
            return { aliasByEnvironmentId: rest };
          }
          if (state.aliasByEnvironmentId[environmentId] === normalized) return state;
          return {
            aliasByEnvironmentId: { ...state.aliasByEnvironmentId, [environmentId]: normalized },
          };
        }),
      clearConnectionAlias: (environmentId) =>
        set((state) => {
          if (!(environmentId in state.aliasByEnvironmentId)) return state;
          const { [environmentId]: _cleared, ...rest } = state.aliasByEnvironmentId;
          return { aliasByEnvironmentId: rest };
        }),
    }),
    {
      name: CONNECTION_ALIAS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ aliasByEnvironmentId: state.aliasByEnvironmentId }),
      merge: (persisted, current) => ({
        ...current,
        aliasByEnvironmentId: sanitizeConnectionAliases(
          (persisted as { aliasByEnvironmentId?: unknown } | null)?.aliasByEnvironmentId,
        ),
      }),
    },
  ),
);

/** The alias map, for the one place that resolves environments to display names. */
export function useConnectionAliases(): Record<string, string> {
  return useConnectionAliasStore((store) => store.aliasByEnvironmentId);
}

/** One environment's raw alias, for the editors. `null` when it has none. */
export function useConnectionAlias(environmentId: string | null): string | null {
  return useConnectionAliasStore((store) =>
    environmentId === null ? null : (store.aliasByEnvironmentId[environmentId] ?? null),
  );
}
