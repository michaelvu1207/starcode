/**
 * Web-side terminal-history atoms.
 *
 * Instantiates the client-runtime atom families once against the connection
 * runtime, mirroring `state/usage.ts`. Deliberately no cross-environment
 * fan-out atom: reading history is lazy, and an atom that read every machine
 * would fetch from all four the moment the sidebar rendered.
 *
 * Three reads, and the third is narrower than it looks. The listing and the
 * bounded preview are the picker's data source: which sessions a machine has,
 * and enough of each to tell them apart. The paged reader is not the history
 * viewer coming back — that was a destination, reachable for any session on
 * any machine, and it is still gone. It serves one section inside one thread,
 * scoped to the session that thread already carries in its model's context.
 */
import {
  createEnvironmentTerminalHistoryAtoms,
  historySessionsAtomKey,
  historyEntriesAtomKey,
  historyPreviewAtomKey,
  type HistoryEntriesKey,
  type HistoryForkAttempt,
  type HistoryImportAttempt,
  type HistorySessionsKey,
  type HistoryPreviewKey,
} from "@t3tools/client-runtime/state/terminal-history";
import type {
  EnvironmentId,
  HistoryForkRequest,
  HistoryImportRequest,
  HistoryImportsPage,
  HistoryPreview,
  HistorySessionId,
  HistorySessionsPage,
  HistoryTranscriptPage,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomRefresh } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery, type EnvironmentQueryView } from "./query";
import { useAtomCommand } from "./use-atom-command";

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

const entriesViewAtom = Atom.family((serializedKey: string) =>
  unwrap(environmentTerminalHistory.entriesAtom(serializedKey)),
);

/**
 * One page of an imported or forked thread's earlier conversation.
 *
 * `key` is null while nothing should be fetched — a collapsed section, or a
 * page nobody has scrolled back to yet — so the hook can sit unconditionally
 * at the top of a component while the request stays lazy. That laziness is the
 * feature: these sessions run past 38 MB, and none of this is read at
 * thread-open time.
 */
export function useHistoryEntriesPage(
  key: HistoryEntriesKey | null,
): EnvironmentQueryView<HistoryTranscriptPage | null> {
  return useEnvironmentQuery(key === null ? null : entriesViewAtom(historyEntriesAtomKey(key)));
}

const importsViewAtom = Atom.family((environmentId: EnvironmentId) =>
  unwrap(environmentTerminalHistory.importsAtom(environmentId)),
);

/**
 * Which of a machine's CLI sessions have already become threads.
 *
 * Cached per environment and read by two surfaces: the picker, to badge a row
 * as imported and offer to open it instead, and an imported thread itself, to
 * say where it came from. `null` covers both "still loading" and "this machine
 * cannot say" — the latter on a server predating the route — and both must
 * render as no badge rather than as "not imported".
 */
export function useHistoryImports(
  environmentId: EnvironmentId | null,
): EnvironmentQueryView<HistoryImportsPage | null> {
  return useEnvironmentQuery(environmentId === null ? null : importsViewAtom(environmentId));
}

/**
 * Re-reads a machine's import registry, for the one caller that knows it just
 * changed: the picker, immediately after an import.
 *
 * Deliberately not `useHistoryImports(...).refresh`. That refresh targets the
 * derived atom these views expose, and refreshing a derivation recomputes the
 * mapping rather than re-running the fetch underneath it — the value comes back
 * identical and the freshly imported thread renders with no provenance line.
 * This one targets the source.
 */
export function useRefreshHistoryImports(environmentId: EnvironmentId | null): () => void {
  const refresh = useAtomRefresh(
    environmentTerminalHistory.importsAtom(environmentId ?? PLACEHOLDER_ENVIRONMENT_ID),
  );
  return environmentId === null ? NOOP : refresh;
}

/**
 * The imperative twins of the two hooks above, for callers that only learn
 * which machine they are asking about when the user clicks.
 *
 * The sidebar's context menu is the case: it acts on any row in a list merged
 * from every connected machine, so it cannot hold a hook per environment, and
 * hooking every row to answer a question nobody asked is what the row menu was
 * built to avoid in the first place.
 */
export function refreshHistoryImports(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(environmentTerminalHistory.importsAtom(environmentId));
}

/**
 * Best-effort: `null` while the registry is cold or still in flight, which the
 * one caller treats the same way the menu already treated a pending read —
 * as "cannot prove this thread carries a conversation", never as a promise
 * that it does.
 */
export function readHistoryImports(environmentId: EnvironmentId): HistoryImportsPage | null {
  const result = appAtomRegistry.get(importsViewAtom(environmentId));
  return AsyncResult.isSuccess(result) ? result.value : null;
}

const NOOP = () => {};
/**
 * `useAtomRefresh` cannot be called conditionally, so a null environment still
 * needs an atom to point at. This id belongs to no machine, so the atom it
 * keys is never fetched — only ever refreshed into the void by the no-op above.
 */
const PLACEHOLDER_ENVIRONMENT_ID = "history-imports-no-environment" as EnvironmentId;

/**
 * Runs one import. Resolves to the outcome the dialog renders — including the
 * refusals, which are values here rather than failures.
 */
export function useImportHistorySession(): (input: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: HistorySessionId;
  readonly request: HistoryImportRequest;
}) => Promise<HistoryImportAttempt> {
  const run = useAtomCommand(environmentTerminalHistory.importCommand, {
    label: "web:history:import",
    // The command's failure channel is empty by construction: the loader turns
    // every refusal and every unreachable machine into a value. A toast here
    // would only ever fire on a defect, and the dialog says it better.
    reportFailure: false,
  });
  return async (input) => {
    const result = await run({
      environmentId: input.environmentId,
      input: { sessionId: input.sessionId, request: input.request },
    });
    return AsyncResult.isSuccess(result)
      ? result.value
      : { kind: "unavailable", message: "The import could not be started." };
  };
}

/**
 * Runs one conversation fork. Resolves to the outcome the caller renders —
 * including the refusals, which are values here rather than failures, because
 * "this driver cannot fork" is the sentence the caller needs, not a toast
 * saying something went wrong.
 */
export function useForkThreadConversation(): (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: HistoryForkRequest;
}) => Promise<HistoryForkAttempt> {
  const run = useAtomCommand(environmentTerminalHistory.forkCommand, {
    label: "web:history:fork",
    // Empty failure channel by construction: the loader turns every refusal
    // and every unreachable machine into a value.
    reportFailure: false,
  });
  return async (input) => {
    const result = await run({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, request: input.request },
    });
    return AsyncResult.isSuccess(result)
      ? result.value
      : { kind: "unavailable", message: "The fork could not be started." };
  };
}
