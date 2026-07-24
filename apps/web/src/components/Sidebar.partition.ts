/**
 * The sidebar v2 partition: every visible thread from every connected
 * environment, split into the active inbox, the snooze shelf, and the settled
 * tail, each in its own order.
 *
 * Lifted out of SidebarV2.tsx rather than edited in place. That file is the
 * busiest component upstream touches, so a fork diff inside it re-conflicts on
 * every rebase; here the call site stays one line and this module is ours.
 *
 * Ordering by section:
 *  - active — `sidebarV2ThreadSortOrder`. "activity" ranks by attention band
 *    (see SidebarV2.activity), "created_at" is upstream's static order where a
 *    row never moves until its lifecycle changes.
 *  - snoozed — soonest wake first: "what comes back next" is the shelf's question.
 *  - settled — when the work ENDED, not when it was created or last touched.
 */
import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  SidebarV2ThreadSortOrder,
} from "@t3tools/contracts";

import {
  firstValidTimestampMs,
  sortSettledThreadsForSidebarV2,
  sortThreadsForSidebarV2,
} from "./Sidebar.logic";
import { rankThreadsForSidebarV2 } from "./SidebarV2.activity";

export interface SidebarV2Partition {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settledThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** The real-clock instant the snooze classification ran at, so callers label
      wakes against the same moment the shelf was built from. */
  readonly snoozeNow: string;
}

export interface SidebarV2PartitionInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** `null` means "all projects"; otherwise `environmentId:projectId` keys. */
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  /** Narrower than the ServerConfig map the caller holds: capability skew is
      the only thing the partition asks a server descriptor about. */
  readonly serverConfigs: ReadonlyMap<
    EnvironmentId,
    { readonly environment: { readonly capabilities: ExecutionEnvironmentCapabilities } }
  >;
  readonly changeRequestStateByKey: ReadonlyMap<string, "open" | "closed" | "merged">;
  readonly autoSettleAfterDays: number | null;
  readonly threadLastVisitedAtById: Readonly<Record<string, string>>;
  readonly threadSortOrder: SidebarV2ThreadSortOrder;
  /** Minute-quantized clock for the settle window: the coarse tick is what
      keeps effectiveSettled memos from thrashing on every shell event. */
  readonly nowMinute: string;
}

export function partitionSidebarV2Threads(input: SidebarV2PartitionInput): SidebarV2Partition {
  const now = `${input.nowMinute}:00.000Z`;
  // Snooze classification uses a REAL clock, not the quantized minute: wake
  // times are second-precise and a woken thread must not linger on the shelf
  // for the rest of the minute.
  const preciseNow = new Date().toISOString();
  const visible = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      (input.scopedProjectKeys === null ||
        input.scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
  const active: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  for (const thread of visible) {
    // Threads on servers without the settlement capability (old server, or
    // descriptor not loaded yet) never classify as settled: the user could
    // neither un-settle nor pin them, so auto-settling them would strand rows
    // in a tail with no working affordances.
    const capabilities = input.serverConfigs.get(thread.environmentId)?.environment.capabilities;
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const changeRequestState = input.changeRequestStateByKey.get(threadKey) ?? null;
    // Snooze outranks settled classification: an explicitly snoozed thread
    // belongs to the shelf even if it would also auto-settle (the shelf's wake
    // time is a stronger statement about when it matters again).
    if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: preciseNow })) {
      snoozed.push(thread);
    } else if (
      capabilities?.threadSettlement === true &&
      effectiveSettled(thread, {
        now,
        autoSettleAfterDays: input.autoSettleAfterDays,
        changeRequestState,
      })
    ) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  return {
    activeThreads:
      input.threadSortOrder === "activity"
        ? rankThreadsForSidebarV2(active, {
            lastVisitedAt: (thread) =>
              input.threadLastVisitedAtById[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ],
          })
        : sortThreadsForSidebarV2(active),
    snoozedThreads: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settledThreads: sortSettledThreadsForSidebarV2(settled),
    snoozeNow: preciseNow,
  };
}
