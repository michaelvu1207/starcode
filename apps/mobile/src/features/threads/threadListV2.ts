import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationThreadSubagent, ProjectId } from "@starcode/contracts";

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
 *
 * Four visual states, three colors: color is reserved for "act now"
 * (approval), "in motion" (working), and "broken" (failed). Ready is the
 * unlabeled resting state.
 */
export type ThreadListV2Status = "approval" | "input" | "working" | "agents" | "failed" | "ready";

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "subagents"
  >,
): ThreadListV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  // The main agent stopped but work is still happening: a backgrounded
  // subagent outlives the turn that spawned it, so the session goes ready
  // while the agent keeps running. Without this the row reads as finished —
  // idle-looking and busy at the same time. Ranked below `working` for the
  // same reason as web: when the main agent is running too, "Working" already
  // says the thread is busy.
  if ((thread.subagents?.length ?? 0) > 0) {
    return "agents";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * v2 sort: static creation order, newest thread on top. Activity NEVER
 * reorders the list — a row holds its position for its whole life, so the
 * screen only moves at lifecycle transitions. Mirrors web's
 * sortThreadsForSidebarV2.
 */
export function sortThreadsForListV2<T extends { readonly id: string; readonly createdAt: string }>(
  threads: readonly T[],
): T[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * A row in the list: either a thread, or one of its live subagents.
 *
 * A union rather than nesting agents inside the thread item, because the list
 * is flat and native: FlatList wants one row per entry, and giving an agent
 * its own entry is what lets it be pressed, keyed and measured like any other
 * row instead of becoming a special case inside the thread row's layout.
 */
export type ThreadListV2Item =
  | {
      readonly kind: "thread";
      readonly thread: EnvironmentThreadShell;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "agent";
      readonly thread: EnvironmentThreadShell;
      readonly agent: OrchestrationThreadSubagent;
      readonly isLast: boolean;
    };

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
}

/**
 * The visible threads, filtered and ordered, matching the web v2 list.
 *
 * There used to be a partition here — an active card block above a receded
 * tail of work that had been put away. Threads no longer have that state, so
 * the list is one block in one order.
 */
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
}): ThreadListV2Layout {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const visible: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    // Callers pass live (unarchived) shells.
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      continue;
    }
    if (query.length > 0 && !thread.title.toLocaleLowerCase().includes(query)) continue;
    visible.push(thread);
  }

  // Agents follow the thread that spawned them, so the list reads as a shallow
  // tree without becoming one. Only live agents appear, so a project of quiet
  // threads looks exactly as it did before.
  const items: ThreadListV2Item[] = [];
  for (const thread of sortThreadsForListV2(visible)) {
    items.push({ kind: "thread", thread, isLast: false });
    for (const agent of thread.subagents ?? []) {
      items.push({ kind: "agent", thread, agent, isLast: false });
    }
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return { items };
}
