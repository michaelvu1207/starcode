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
import type { EnvironmentConnectionPresentation } from "@starcode/client-runtime/connection";
import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@starcode/client-runtime/environment";
import type { EnvironmentId } from "@starcode/contracts";

import {
  buildSidebarConnectionGroups,
  type SidebarConnectionEnvironment,
} from "../Sidebar.connections";
import { resolveSidebarV2Status, type SidebarV2Status } from "../Sidebar.logic";

export interface WorkbenchBoardCard {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
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
}

export interface WorkbenchBoardInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
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
}

export interface WorkbenchBoard {
  readonly groups: ReadonlyArray<WorkbenchBoardGroup>;
  readonly cardCount: number;
  readonly masterCreatedCount: number;
}

export function buildWorkbenchBoard(input: WorkbenchBoardInput): WorkbenchBoard {
  const groups = buildSidebarConnectionGroups({
    threads: input.threads,
    environments: input.environments,
    primaryEnvironmentId: input.primaryEnvironmentId,
  });

  let cardCount = 0;
  let masterCreatedCount = 0;

  const boardGroups = groups.map((group): WorkbenchBoardGroup => {
    const cards: WorkbenchBoardCard[] = [];
    for (const thread of group.rows) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (key === input.masterThreadKey) continue;
      if (input.includeThreadKey != null && !input.includeThreadKey(key)) continue;
      const masterCreated = input.masterCreatedThreadIds.has(thread.id);
      if (masterCreated) masterCreatedCount += 1;
      cards.push({
        key,
        thread,
        status: resolveSidebarV2Status(thread),
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
    };
  });

  return { groups: boardGroups, cardCount, masterCreatedCount };
}
