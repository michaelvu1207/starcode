/**
 * Peer transcript rendering - pure projections of a peer's snapshots.
 *
 * Everything here is total and side-effect free so the shapes an agent sees can
 * be tested without a peer. The renderer is deliberately lossy: it emits roles,
 * message text, and tool-call names, and never the tool payloads, which is what
 * keeps a federated read bounded regardless of how large the peer's thread is.
 *
 * @module PeerTranscript
 */
import {
  PEER_TRANSCRIPT_ENTRY_MAX_CHARS,
  PEER_TRANSCRIPT_MAX_TOOL_CALLS,
  resolveLocalProjectMembership,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type PeerName,
  type PeerThreadCursor,
  type PeerThreadStatus,
  type PeerThreadSummary,
  type PeerTranscriptEntry,
  type ProjectCategoryRecord,
  type ProjectCategorySlug,
  type ThreadId,
} from "@t3tools/contracts";

const TOOL_CALL_NAME_MAX_CHARS = 80;

/**
 * A thread's most recent activity across every timestamp it carries. Peers keep
 * their own clocks, so this only ever compares timestamps produced by the same
 * machine — never against local `now`.
 */
export const peerThreadLastActivityAt = (
  thread: Pick<
    OrchestrationThreadShell,
    "updatedAt" | "createdAt" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
): string => {
  const candidates = [
    thread.updatedAt,
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.completedAt ?? null,
    thread.latestTurn?.startedAt ?? null,
    thread.latestTurn?.requestedAt ?? null,
    thread.session?.updatedAt ?? null,
  ];
  let best = thread.updatedAt;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const parsed = Date.parse(candidate);
    if (Number.isNaN(parsed) || parsed <= bestMs) continue;
    best = candidate;
    bestMs = parsed;
  }
  return best;
};

/**
 * Coarse status from shell fields only. Needs-attention states win over
 * lifecycle states so a listing never buries a thread that is waiting on a
 * human behind one that merely finished.
 */
export const resolvePeerThreadStatus = (
  thread: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session" | "archivedAt"
  >,
): PeerThreadStatus => {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.latestTurn?.state === "running") return "working";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "failed";
  if (thread.archivedAt !== null) return "archived";
  return "idle";
};

/**
 * Which project a peer's thread sits under, once its catalog has been read.
 *
 * `undefined` is not the same as `null` here and the distinction is the whole
 * point: `undefined` means the peer never told us — its catalog was unreachable,
 * or it runs a server from before projects — and the key is omitted so a filter
 * can tell "unknown" from "unfiled". `null` means we read the catalog and the
 * thread is genuinely under no project.
 */
export type PeerThreadProject = ProjectCategorySlug | null | undefined;

export const summarizePeerThread = (
  peer: PeerName,
  thread: OrchestrationThreadShell,
  project: PeerThreadProject = undefined,
): PeerThreadSummary => ({
  peer,
  threadId: thread.id,
  title: thread.title,
  provider: thread.session?.providerName ?? thread.modelSelection.instanceId ?? null,
  model: thread.modelSelection.model ?? null,
  status: resolvePeerThreadStatus(thread),
  lastActivityAt: peerThreadLastActivityAt(thread),
  createdAt: thread.createdAt,
  branch: thread.branch,
  // Forwarded only when the source thread reported one, so an absent key keeps
  // meaning "this server does not compute plan summaries" rather than "this
  // thread has no plan".
  ...(thread.planSummary === undefined ? {} : { planSummary: thread.planSummary }),
  ...(project === undefined ? {} : { project }),
});

/**
 * Fold a peer's own catalog into a thread-to-slug lookup.
 *
 * Reuses `resolveLocalProjectMembership` rather than re-deriving membership
 * here: that function already encodes explicit thread filing, folder bindings,
 * exclusions and the slug ordering that keeps a thread bound to two categories
 * from flipping between them. A second implementation would be a second set of
 * rules to keep in step, and the one on the peer is the one that decides what
 * the peer's own sidebar shows.
 */
export const peerProjectByThread = (input: {
  readonly categories: ReadonlyArray<ProjectCategoryRecord>;
  readonly threads: ReadonlyArray<Pick<OrchestrationThreadShell, "id" | "projectId">>;
}): ReadonlyMap<ThreadId, ProjectCategorySlug> => {
  const bySlug = resolveLocalProjectMembership({
    categories: input.categories,
    threads: input.threads.map((thread) => ({ id: thread.id, projectId: thread.projectId })),
  });
  const byThread = new Map<ThreadId, ProjectCategorySlug>();
  for (const [slug, threadIds] of bySlug) {
    for (const threadId of threadIds) if (!byThread.has(threadId)) byThread.set(threadId, slug);
  }
  return byThread;
};

const descendingBy = (
  timestampOf: (summary: PeerThreadSummary) => string,
): ((a: PeerThreadSummary, b: PeerThreadSummary) => number) => {
  return (a, b) => {
    const left = Date.parse(timestampOf(a));
    const right = Date.parse(timestampOf(b));
    const leftMs = Number.isNaN(left) ? Number.NEGATIVE_INFINITY : left;
    const rightMs = Number.isNaN(right) ? Number.NEGATIVE_INFINITY : right;
    if (leftMs !== rightMs) return rightMs - leftMs;
    // Descending on the tiebreak too, so it matches the cursor comparison
    // below and paging cannot skip or repeat a row at a shared timestamp.
    return b.threadId.localeCompare(a.threadId);
  };
};

/** Most-recent-first, with a stable tiebreak so equal timestamps do not shuffle. */
export const comparePeerThreadsByActivity = descendingBy((summary) => summary.lastActivityAt);

/** Newest-first by creation. The only order a `(createdAt, threadId)` cursor can traverse. */
export const comparePeerThreadsByCreation = descendingBy((summary) => summary.createdAt);

/**
 * Keeps only the threads strictly after the cursor in creation order, matching
 * the comparator above so a page boundary never drops or duplicates a thread
 * whose `createdAt` ties with the cursor's.
 */
export const applyPeerThreadCursor = (
  threads: ReadonlyArray<PeerThreadSummary>,
  cursor: PeerThreadCursor,
): ReadonlyArray<PeerThreadSummary> => {
  const cursorMs = Date.parse(cursor.createdAt);
  const cursorKey = Number.isNaN(cursorMs) ? Number.NEGATIVE_INFINITY : cursorMs;
  return threads.filter((thread) => {
    const parsed = Date.parse(thread.createdAt);
    const threadKey = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (threadKey !== cursorKey) return threadKey < cursorKey;
    return thread.threadId.localeCompare(cursor.threadId) < 0;
  });
};

const clip = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;

const toolCallName = (activity: OrchestrationThreadActivity): string => {
  const summary =
    activity.kind === "tool.started" ? activity.summary.replace(/ started$/, "") : activity.summary;
  return clip(summary.trim(), TOOL_CALL_NAME_MAX_CHARS);
};

/**
 * Tool-call names per turn, deduped and capped. `tool.completed` activities are
 * preferred because their title is the settled tool name; started/updated
 * entries only fill in turns that are still running.
 */
const toolCallsByTurn = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byTurn = new Map<string, string[]>();
  const ordered = [
    ...activities.filter((activity) => activity.kind === "tool.completed"),
    ...activities.filter((activity) => activity.kind !== "tool.completed"),
  ];
  for (const activity of ordered) {
    if (activity.tone !== "tool" || activity.turnId === null) continue;
    const names = byTurn.get(activity.turnId) ?? [];
    if (names.length >= PEER_TRANSCRIPT_MAX_TOOL_CALLS) continue;
    const name = toolCallName(activity);
    if (name.length === 0 || names.includes(name)) continue;
    names.push(name);
    byTurn.set(activity.turnId, names);
  }
  return byTurn;
};

export interface PeerTranscriptPage {
  readonly totalEntries: number;
  readonly entries: ReadonlyArray<PeerTranscriptEntry>;
  readonly hasMore: boolean;
  readonly nextBefore: number | null;
}

/**
 * Renders a bounded window of a thread's transcript.
 *
 * `before` is an exclusive upper bound on the transcript index, so paging back
 * is `before = nextBefore` until `hasMore` is false. Indices are positions in
 * the full message list, which is stable for any already-persisted message.
 */
export const renderPeerTranscript = (
  thread: Pick<OrchestrationThread, "messages" | "activities">,
  options: {
    readonly limit: number;
    readonly before?: number | undefined;
    readonly maxTextChars?: number | undefined;
  },
): PeerTranscriptPage => {
  const messages = thread.messages;
  const totalEntries = messages.length;
  const maxTextChars = options.maxTextChars ?? PEER_TRANSCRIPT_ENTRY_MAX_CHARS;
  const upperBound = Math.min(options.before ?? totalEntries, totalEntries);
  const endIndex = Math.max(upperBound, 0);
  const startIndex = Math.max(endIndex - Math.max(options.limit, 0), 0);
  const toolCalls = toolCallsByTurn(thread.activities);

  const entries = messages.slice(startIndex, endIndex).map((message, offset) => {
    const text = message.text;
    return {
      index: startIndex + offset,
      role: message.role,
      text: clip(text, maxTextChars),
      truncated: text.length > maxTextChars,
      toolCalls: message.turnId === null ? [] : (toolCalls.get(message.turnId) ?? []),
      createdAt: message.createdAt,
    } satisfies PeerTranscriptEntry;
  });

  return {
    totalEntries,
    entries,
    hasMore: startIndex > 0,
    nextBefore: startIndex > 0 ? startIndex : null,
  };
};
