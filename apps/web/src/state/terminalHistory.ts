/**
 * Web-side terminal-history atoms.
 *
 * Instantiates the client-runtime atom families once against the connection
 * runtime, mirroring `state/usage.ts`. Deliberately no cross-environment
 * fan-out atom: the strip is lazy, and an atom that read every machine would
 * fetch from all four the moment the sidebar rendered.
 */
import {
  createEnvironmentTerminalHistoryAtoms,
  historySessionsAtomKey,
  historyTranscriptAtomKey,
  type HistorySessionsKey,
  type HistoryTranscriptKey,
} from "@t3tools/client-runtime/state/terminal-history";
import type { HistorySessionsPage, HistoryTranscriptPage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";

const environmentTerminalHistory = createEnvironmentTerminalHistoryAtoms(connectionAtomRuntime);

/**
 * The loader resolves absence (including an old server's 404) to `None`, so
 * these views collapse `Option` into `null`. The distinction the UI needs is
 * "still loading" versus "resolved to nothing", and `isPending` carries that.
 */
const unwrap = <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<Option.Option<A>, E>>,
): Atom.Atom<AsyncResult.AsyncResult<A | null, E>> =>
  Atom.make((get) => AsyncResult.map(get(atom), (value) => Option.getOrNull(value)));

const sessionsViewAtom = Atom.family((serializedKey: string) =>
  unwrap(environmentTerminalHistory.sessionsAtom(serializedKey)),
);

const transcriptViewAtom = Atom.family((serializedKey: string) =>
  unwrap(environmentTerminalHistory.transcriptAtom(serializedKey)),
);

/**
 * One page of a machine's session listing.
 *
 * `key` may be null while nothing should be fetched yet — a collapsed strip,
 * or a page the user has not asked for. `useEnvironmentQuery` accepts a null
 * atom, so the hook can be called unconditionally at the top of a component
 * while the fetch itself stays lazy.
 */
export function useHistorySessionsPage(
  key: HistorySessionsKey | null,
): EnvironmentQueryView<HistorySessionsPage | null> {
  return useEnvironmentQuery(key === null ? null : sessionsViewAtom(historySessionsAtomKey(key)));
}

export function useHistoryTranscriptPage(
  key: HistoryTranscriptKey | null,
): EnvironmentQueryView<HistoryTranscriptPage | null> {
  return useEnvironmentQuery(
    key === null ? null : transcriptViewAtom(historyTranscriptAtomKey(key)),
  );
}
