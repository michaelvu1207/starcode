/**
 * Attention ranking for the sidebar v2 inbox.
 *
 * `sortThreadsForSidebarV2` orders by creation and never lets activity move a
 * row, so the screen only shifts at lifecycle transitions. That trade holds
 * for one machine. The list is a single flat stream merged from every
 * connected environment, and across N machines creation order buries the only
 * question worth answering at a glance: which thread, on which machine, is
 * blocked on you right now. Ranked order is the opposite trade and is chosen
 * per user via `sidebarV2ThreadSortOrder`.
 *
 * Bands measure how much a human is the blocker, not how busy a thread is: a
 * running turn needs nobody yet, so it lands in the quiet band and rises on
 * its activity alone. Ordering within a band is last real activity, newest
 * first, matching the timestamp the auto-settle window already runs on.
 */
import { threadLastActivityAt } from "@starcode/client-runtime/state/thread-activity";
import type { OrchestrationThreadShell } from "@starcode/contracts";

import {
  firstValidTimestampMs,
  hasUnseenCompletion,
  resolveSidebarV2Status,
} from "./Sidebar.logic";

export type SidebarV2AttentionBand = "approval" | "input" | "failed" | "unread" | "quiet";

const ATTENTION_BAND_RANK: Record<SidebarV2AttentionBand, number> = {
  approval: 0,
  input: 1,
  failed: 2,
  unread: 3,
  quiet: 4,
};

/**
 * Which kind of attention a thread is waiting on, derived entirely from the
 * signals the sidebar already renders: the v2 status model plus the unread
 * completion mark. `lastVisitedAt` is the viewer's local visit stamp — absent
 * means never visited, which counts as read (same rule the row badge uses, so
 * a fresh client doesn't rank its whole history as urgent).
 */
export function resolveSidebarV2AttentionBand(
  thread: OrchestrationThreadShell,
  options: { readonly lastVisitedAt: string | undefined },
): SidebarV2AttentionBand {
  const status = resolveSidebarV2Status(thread);
  if (status === "approval") return "approval";
  if (status === "input") return "input";
  if (status === "failed") return "failed";
  if (
    status === "ready" &&
    hasUnseenCompletion({ ...thread, lastVisitedAt: options.lastVisitedAt })
  )
    return "unread";
  return "quiet";
}

/** Sort key for the within-band order: last real activity, falling back to
    creation so a thread that has never run still sorts sanely. */
export function sidebarV2ActivityTimestampMs(thread: OrchestrationThreadShell): number {
  return firstValidTimestampMs(threadLastActivityAt(thread), thread.createdAt);
}

/**
 * Attention band first, then most recent activity. Decorated up front rather
 * than resolved inside the comparator: the key is derived from several fields
 * and a shell's `id` is only unique within its own environment, so a keyed
 * cache would collide across machines.
 */
export function rankThreadsForSidebarV2<T extends OrchestrationThreadShell>(
  threads: readonly T[],
  options: { readonly lastVisitedAt: (thread: T) => string | undefined },
): T[] {
  return threads
    .map((thread) => ({
      thread,
      rank: ATTENTION_BAND_RANK[
        resolveSidebarV2AttentionBand(thread, { lastVisitedAt: options.lastVisitedAt(thread) })
      ],
      activityMs: sidebarV2ActivityTimestampMs(thread),
    }))
    .toSorted(
      (left, right) =>
        left.rank - right.rank ||
        right.activityMs - left.activityMs ||
        left.thread.id.localeCompare(right.thread.id),
    )
    .map((entry) => entry.thread);
}
