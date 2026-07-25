/**
 * Terminal-history strip logic.
 *
 * Pure, and separated from the view for the same reason `Sidebar.connections.ts`
 * is: the paging accumulation and the "can this machine even serve history"
 * question both have edge cases worth asserting, and neither needs React.
 */
import {
  HISTORY_STRIP_PAGE_SIZE,
  type HistorySessionsKey,
} from "@t3tools/client-runtime/state/terminal-history";
import type { EnvironmentId, HistorySessionsPage, HistorySessionSummary } from "@t3tools/contracts";

export { HISTORY_STRIP_PAGE_SIZE };

/**
 * Collapse state rides the same persisted record F4 used for connection groups
 * (`useUiStateStore.projectExpandedById`, localStorage-backed), under a second
 * namespaced key. Reusing it keeps the fork out of the store's shape entirely.
 *
 * Unlike a connection group, this defaults **collapsed**. That default is what
 * makes the strip lazy: nothing is fetched from any machine until someone asks
 * to see it, so opening the sidebar never costs four HTTP round trips.
 */
export function sidebarTerminalHistoryExpansionKey(environmentId: EnvironmentId): string {
  return `sidebar-connection-history:${environmentId}`;
}

export function resolveSidebarTerminalHistoryExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  environmentId: EnvironmentId,
): boolean {
  return projectExpandedById[sidebarTerminalHistoryExpansionKey(environmentId)] ?? false;
}

/**
 * One page request in the strip's paging chain.
 *
 * `since` is absent for the first page, which lets the server apply its own
 * seven-day default. "Show older" first re-asks with the window opened
 * (`since: ""`), then follows cursors from there — so the common case stays a
 * small, recent listing and the full history is still reachable.
 */
export interface HistoryStripPageRequest {
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly cursor?: string | undefined;
}

export const HISTORY_STRIP_FIRST_PAGE: HistoryStripPageRequest = {};

/** The window a page request represents, for labelling the "show older" row. */
export type HistoryStripWindow = "recent" | "all";

export const historyStripWindow = (request: HistoryStripPageRequest): HistoryStripWindow =>
  request.since === undefined ? "recent" : "all";

export function historySessionsKeyFor(
  environmentId: EnvironmentId,
  request: HistoryStripPageRequest,
): HistorySessionsKey {
  return {
    environmentId,
    ...(request.since === undefined ? {} : { since: request.since }),
    ...(request.until === undefined ? {} : { until: request.until }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    limit: HISTORY_STRIP_PAGE_SIZE,
  };
}

export interface HistoryStripState {
  readonly sessions: ReadonlyArray<HistorySessionSummary>;
  /** Null when there is nothing further to load in the current direction. */
  readonly nextRequest: HistoryStripPageRequest | null;
  /** Unloaded sessions in the window currently being paged. */
  readonly remainingCount: number;
  /** Unloaded sessions in the whole index, whatever the current window. */
  readonly remainingBeyondWindow: number;
  readonly window: HistoryStripWindow;
}

/**
 * Folds the pages fetched so far into what the strip renders.
 *
 * Two transitions matter. Running out of cursors inside the seven-day window
 * does **not** end paging — it switches to the open window, which is how the
 * strip reaches history older than a week without ever asking for it up front.
 * Running out of cursors in the open window ends it for real.
 *
 * Pages are deduplicated by id. The cursor makes overlap impossible on a
 * static index, but the index revalidates between requests, and a session that
 * was written to in between would otherwise appear twice.
 */
export function foldHistoryStripPages(
  pages: ReadonlyArray<{
    readonly request: HistoryStripPageRequest;
    readonly page: HistorySessionsPage;
  }>,
): HistoryStripState {
  const sessions: HistorySessionSummary[] = [];
  const seen = new Set<string>();
  for (const { page } of pages) {
    for (const session of page.sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
  }

  const last = pages.at(-1);
  if (last === undefined) {
    return {
      sessions,
      nextRequest: HISTORY_STRIP_FIRST_PAGE,
      remainingCount: 0,
      remainingBeyondWindow: 0,
      window: "recent",
    };
  }

  const currentWindow = historyStripWindow(last.request);
  // Count against the window the strip is actually paging. While inside the
  // default seven days, "3,583 more" would be true of the index and a lie
  // about what the next click reveals.
  const remainingCount = Math.max(
    (currentWindow === "recent" ? last.page.totalInWindow : last.page.totalAvailable) -
      sessions.length,
    0,
  );
  const remainingBeyondWindow = Math.max(last.page.totalAvailable - sessions.length, 0);

  const nextRequest =
    last.page.nextCursor !== null
      ? { ...last.request, cursor: last.page.nextCursor }
      : currentWindow === "recent" && remainingBeyondWindow > 0
        ? // The seven-day window is exhausted but the index holds more. Reopen
          // it rather than stopping: this is the "show older" hand-off.
          //
          // `until` is what makes that hand-off useful. The reopened listing is
          // newest-first over the whole index, so without an upper bound its
          // first page would be the same sessions the strip already shows —
          // deduplicated away, leaving a click that visibly does nothing.
          // Bounding it at the oldest row already loaded starts it where the
          // reader is actually looking.
          { since: "", ...oldestBound(sessions) }
        : null;

  return { sessions, nextRequest, remainingCount, remainingBeyondWindow, window: currentWindow };
}

/**
 * Upper bound for a reopened window: the oldest session already shown.
 *
 * Inclusive, so that session comes back once more and is deduplicated — which
 * is safer than trying to nudge the timestamp one millisecond older and risking
 * skipping a session written in the same millisecond.
 */
const oldestBound = (
  sessions: ReadonlyArray<HistorySessionSummary>,
): { readonly until?: string } => {
  const oldest = sessions.at(-1);
  return oldest === undefined ? {} : { until: oldest.lastActivityAt };
};

/**
 * Label for the load-more row, or null when there is nothing more to load.
 *
 * The count is deliberately scoped to what the next click actually reveals:
 * inside the seven-day window that is the rest of the week, and the moment the
 * strip is about to reopen the window it becomes the rest of the index. The
 * two are wildly different numbers - 12 versus 3,583 on this machine.
 */
export function historyStripMoreLabel(state: HistoryStripState): string | null {
  if (state.nextRequest === null) return null;
  if (state.nextRequest.since === "" && state.window === "recent") {
    return state.remainingBeyondWindow === 0 ? null : `Show older (${state.remainingBeyondWindow})`;
  }
  return state.remainingCount === 0 ? null : `Show more (${state.remainingCount})`;
}

/**
 * Whether a machine could not serve history at all.
 *
 * The loader maps every failure, including the 404 from a server that predates
 * these routes, to a resolved absence. That is the state that ships for the
 * minutes between rollout steps, and it must read as "this machine does not
 * offer history" — never a spinner that never resolves and never an error
 * toast.
 */
export function historyStripUnsupported(input: {
  readonly pending: boolean;
  readonly firstPage: HistorySessionsPage | null;
}): boolean {
  return !input.pending && input.firstPage === null;
}
