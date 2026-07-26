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
  ThreadId,
} from "@t3tools/contracts";
import { useAtomRefresh } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

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
