/**
 * Every catalogued machine's raw supervisor connection state in one map.
 *
 * Fork-owned, and deliberately the *raw* state rather than
 * `EnvironmentConnectionPresentation`: the presentation projection collapses
 * `attempt`, `stage`, and `retryAt` away, and "reconnecting, retrying in 8s"
 * is the sentence the connections dropdown exists to say. Everywhere else in
 * the app the lossy projection is the right read — a status dot does not need
 * a retry clock — so this is an addition beside it, not a replacement for it.
 *
 * Fans out inside an atom, mirroring `environmentUsageSnapshotsAtom`, so the
 * number of machines can change without any component changing its hook count.
 */
import type { EnvironmentId } from "@starcode/contracts";
import { useAtomValue } from "@effect/atom-react";
import type { SupervisorConnectionState } from "@starcode/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";

const EMPTY_STATES: ReadonlyMap<EnvironmentId, SupervisorConnectionState> = new Map();

function statesEqual(
  left: ReadonlyMap<EnvironmentId, SupervisorConnectionState>,
  right: ReadonlyMap<EnvironmentId, SupervisorConnectionState>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export const environmentConnectionStatesAtom: Atom.Atom<
  ReadonlyMap<EnvironmentId, SupervisorConnectionState>
> = (() => {
  let previous = EMPTY_STATES;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, SupervisorConnectionState>();
    for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
      const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
      if (Option.isSome(state)) next.set(environmentId, state.value);
    }
    if (statesEqual(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-connection-states"));
})();

export function useEnvironmentConnectionStates(): ReadonlyMap<
  EnvironmentId,
  SupervisorConnectionState
> {
  return useAtomValue(environmentConnectionStatesAtom);
}
