/**
 * Fork-owned: the orchestration board's model — every thread on every machine,
 * as cards grouped by the machine that runs it.
 *
 * Built on F4's grouping rather than beside it. The board and the sidebar's
 * connections view answer the same question ("what is running where"), and two
 * implementations of that would drift the moment one of them learns something
 * about capability skew that the other does not.
 *
 * The master thread itself is removed here: it is rendered as a full chat pane
 * a few hundred pixels to the left, and a card that duplicates it would be the
 * one card on the board that opening does nothing useful.
 */
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  buildSidebarConnectionGroups,
  type SidebarConnectionEnvironment,
  type SidebarConnectionSection,
} from "../Sidebar.connections";
import { resolveSidebarV2Status, type SidebarV2Status } from "../Sidebar.logic";

export interface WorkbenchBoardCard {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly section: SidebarConnectionSection;
  readonly status: SidebarV2Status;
  /** Started by the designated master through the peer tools. */
  readonly masterCreated: boolean;
}

export interface WorkbenchBoardGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal: boolean;
  readonly connection: EnvironmentConnectionPresentation | null;
  readonly cards: ReadonlyArray<WorkbenchBoardCard>;
  /** Cards hidden because the board is not showing settled work. */
  readonly settledHiddenCount: number;
}

export interface WorkbenchBoardInput {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environments: ReadonlyArray<SidebarConnectionEnvironment>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** Thread ids the master's transcript says it created. */
  readonly masterCreatedThreadIds: ReadonlySet<string>;
  /** Scoped key of the designated master, excluded from the cards. */
  readonly masterThreadKey: string | null;
  /**
   * Membership test, for a board scoped to one project rather than to the
   * fleet. Optional and defaulting to "everything", so the Workbench is
   * unchanged. Cards that fail it are dropped outright rather than counted as
   * hidden: they are not this board's work, so there is nothing to reveal.
   */
  readonly includeThreadKey?: ((key: string) => boolean) | null;
  readonly showSettled: boolean;
}

export interface WorkbenchBoard {
  readonly groups: ReadonlyArray<WorkbenchBoardGroup>;
  readonly cardCount: number;
  readonly masterCreatedCount: number;
}

export function buildWorkbenchBoard(input: WorkbenchBoardInput): WorkbenchBoard {
  const groups = buildSidebarConnectionGroups({
    activeThreads: input.activeThreads,
    snoozedThreads: input.snoozedThreads,
    settledThreads: input.settledThreads,
    environments: input.environments,
    primaryEnvironmentId: input.primaryEnvironmentId,
  });

  let cardCount = 0;
  let masterCreatedCount = 0;

  const boardGroups = groups.map((group): WorkbenchBoardGroup => {
    let settledHiddenCount = 0;
    const cards: WorkbenchBoardCard[] = [];
    for (const row of group.rows) {
      const key = scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id));
      if (key === input.masterThreadKey) continue;
      if (input.includeThreadKey != null && !input.includeThreadKey(key)) continue;
      if (row.section === "settled" && !input.showSettled) {
        settledHiddenCount += 1;
        continue;
      }
      const masterCreated = input.masterCreatedThreadIds.has(row.thread.id);
      if (masterCreated) masterCreatedCount += 1;
      cards.push({
        key,
        thread: row.thread,
        section: row.section,
        status: resolveSidebarV2Status(row.thread),
        masterCreated,
      });
    }
    cardCount += cards.length;
    return {
      environmentId: group.environmentId,
      label: group.label,
      isLocal: group.isLocal,
      connection: group.connection,
      cards,
      settledHiddenCount,
    };
  });

  return { groups: boardGroups, cardCount, masterCreatedCount };
}
