/**
 * The sidebar v2 list: every visible thread from every connected environment,
 * in one order.
 *
 * There used to be three lists — the active inbox, a snooze shelf, and a
 * settled tail — because a thread could be put away in two different ways.
 * Both are gone: a thread is either on the list or archived off it, so this is
 * a filter and a sort rather than a partition.
 *
 * Ordering follows `sidebarV2ThreadSortOrder`: "activity" ranks by attention
 * band (see SidebarV2.activity), "created_at" is upstream's static order where
 * a row never moves until its lifecycle changes.
 *
 * Lifted out of SidebarV2.tsx rather than edited in place. That file is the
 * busiest component upstream touches, so a fork diff inside it re-conflicts on
 * every rebase; here the call site stays one line and this module is ours.
 */
import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@starcode/client-runtime/environment";
import type { SidebarV2ThreadSortOrder } from "@starcode/contracts";
import { isListableThread } from "@starcode/contracts";

import { sortThreadsForSidebarV2 } from "./Sidebar.logic";
import { rankThreadsForSidebarV2 } from "./SidebarV2.activity";

export interface SidebarV2PartitionInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** `null` means "all projects"; otherwise `environmentId:projectId` keys. */
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly threadLastVisitedAtById: Readonly<Record<string, string>>;
  readonly threadSortOrder: SidebarV2ThreadSortOrder;
}

export function partitionSidebarV2Threads(
  input: SidebarV2PartitionInput,
): ReadonlyArray<EnvironmentThreadShell> {
  const visible = input.threads.filter(
    (thread) =>
      isListableThread(thread) &&
      (input.scopedProjectKeys === null ||
        input.scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );

  return input.threadSortOrder === "activity"
    ? rankThreadsForSidebarV2(visible, {
        lastVisitedAt: (thread) =>
          input.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ],
      })
    : sortThreadsForSidebarV2(visible);
}
