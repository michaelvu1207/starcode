/**
 * Web-side terminal-history atoms.
 *
 * Instantiates the client-runtime atom families once against the connection
 * runtime, mirroring `state/usage.ts`. Deliberately no cross-environment
 * fan-out atom: reading history is lazy, and an atom that read every machine
 * would fetch from all four the moment the sidebar rendered.
 *
 * Only the session *listing* and a bounded *preview* are exposed. The
 * paginated transcript hook went with the history viewer it existed to feed —
 * starcode does not read old conversations, it resumes them — and what is
 * left here is the picker's data source: which sessions a machine has, and
 * enough of each to tell them apart.
 */
import {
  createEnvironmentTerminalHistoryAtoms,
  historySessionsAtomKey,
  historyPreviewAtomKey,
  type HistorySessionsKey,
  type HistoryPreviewKey,
} from "@t3tools/client-runtime/state/terminal-history";
import type { HistoryPreview, HistorySessionsPage } from "@t3tools/contracts";
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

const previewViewAtom = Atom.family((serializedKey: string) =>
  unwrap(environmentTerminalHistory.previewAtom(serializedKey)),
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

/**
 * Enough of one session to tell it apart from the one next to it.
 *
 * One bounded read with no follow-up: history is import-only, so there is no
 * "load earlier" for this to page.
 */
export function useHistoryPreview(
  key: HistoryPreviewKey | null,
): EnvironmentQueryView<HistoryPreview | null> {
  return useEnvironmentQuery(key === null ? null : previewViewAtom(historyPreviewAtomKey(key)));
}
