/**
 * The sidebar v2 connections view: the same threads the inbox shows, regrouped
 * under the machine that runs them.
 *
 * The grouping is deliberately a fold over the inbox partition rather than its
 * own pass over the raw shells. Two reasons: the partition is where the
 * capability-skew rule lives (a thread on a server too old to report
 * settle/snooze must never be classified away), and a second classifier would
 * drift from the inbox the first time either changes. Feed it the partition
 * and the two views can only ever disagree about layout.
 *
 * Order inside a group is the inbox's order, preserved: active first (ranked
 * by attention, or by creation when the user opted out), then the snooze shelf
 * by soonest wake, then the settled tail by when the work ended. Order OF the
 * groups is local first — it is the machine you are sitting at — then by
 * label, which never moves under you the way an activity ranking would.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, SidebarV2ViewMode } from "@t3tools/contracts";

/** How many rows a group shows before it asks. Groups are collapsible and a
    hub sees every machine's history at once, so the cap is per group. */
export const SIDEBAR_CONNECTION_ROWS_INITIAL_COUNT = 25;
export const SIDEBAR_CONNECTION_ROWS_PAGE_COUNT = 25;

/** Which inbox section a row came from — the row's affordances (settle,
    un-settle, wake) follow from it, so grouping has to carry it along. */
export type SidebarConnectionSection = "active" | "snoozed" | "settled";

export interface SidebarConnectionRow {
  readonly thread: EnvironmentThreadShell;
  readonly section: SidebarConnectionSection;
}

/** Narrower than the EnvironmentPresentation the caller holds: a group asks a
    connection for its name and whether it is up, nothing else. */
export interface SidebarConnectionEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
}

export interface SidebarConnectionGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The environment this client is itself hosted by, if any. */
  readonly isLocal: boolean;
  /** `null` when the environment is not in the catalog at all — a thread cached
      from a connection that has since been removed. Its rows still render:
      hiding threads is the one thing this view must never do. */
  readonly connection: EnvironmentConnectionPresentation | null;
  readonly rows: ReadonlyArray<SidebarConnectionRow>;
}

export interface SidebarConnectionsInput {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environments: ReadonlyArray<SidebarConnectionEnvironment>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}

export function buildSidebarConnectionGroups(
  input: SidebarConnectionsInput,
): ReadonlyArray<SidebarConnectionGroup> {
  const rowsByEnvironment = new Map<EnvironmentId, SidebarConnectionRow[]>();
  const pushRows = (
    threads: ReadonlyArray<EnvironmentThreadShell>,
    section: SidebarConnectionSection,
  ) => {
    for (const thread of threads) {
      const rows = rowsByEnvironment.get(thread.environmentId);
      if (rows === undefined) {
        rowsByEnvironment.set(thread.environmentId, [{ thread, section }]);
      } else {
        rows.push({ thread, section });
      }
    }
  };
  // Section order within a group mirrors the inbox top to bottom.
  pushRows(input.activeThreads, "active");
  pushRows(input.snoozedThreads, "snoozed");
  pushRows(input.settledThreads, "settled");

  const groups: SidebarConnectionGroup[] = input.environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    isLocal: environment.environmentId === input.primaryEnvironmentId,
    connection: environment.connection,
    rows: rowsByEnvironment.get(environment.environmentId) ?? [],
  }));

  // Threads whose environment has no catalog entry (removed connection, or a
  // catalog that has not loaded yet) get their own group rather than
  // disappearing. The id is the only honest label available.
  const known = new Set(input.environments.map((environment) => environment.environmentId));
  for (const [environmentId, rows] of rowsByEnvironment) {
    if (known.has(environmentId)) continue;
    groups.push({
      environmentId,
      label: environmentId,
      isLocal: environmentId === input.primaryEnvironmentId,
      connection: null,
      rows,
    });
  }

  return groups.toSorted((left, right) => {
    if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
    // Unknown connections sink below real ones: they are wreckage, not machines
    // you can reach.
    if ((left.connection === null) !== (right.connection === null)) {
      return left.connection === null ? 1 : -1;
    }
    return (
      left.label.localeCompare(right.label) || left.environmentId.localeCompare(right.environmentId)
    );
  });
}

/**
 * The visible slice of a group. Same paging rule the settled tail uses: the
 * thread open in the chat pane is never the one hidden behind "show more",
 * or its highlight and affordances would be unreachable.
 */
export function limitSidebarConnectionRows(
  rows: ReadonlyArray<SidebarConnectionRow>,
  visibleCount: number,
  routeThreadKey: string | null,
): { readonly rows: ReadonlyArray<SidebarConnectionRow>; readonly hiddenCount: number } {
  if (rows.length <= visibleCount) return { rows, hiddenCount: 0 };
  const visible = rows.slice(0, visibleCount);
  if (routeThreadKey !== null) {
    const routeRow = rows
      .slice(visibleCount)
      .find(
        (row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) ===
          routeThreadKey,
      );
    if (routeRow !== undefined) visible.push(routeRow);
  }
  return { rows: visible, hiddenCount: rows.length - visible.length };
}

/**
 * Collapse state rides the same persisted record project groups use
 * (`useUiStateStore.projectExpandedById`, localStorage-backed): one namespaced
 * key per environment, expanded unless the user says otherwise. Reusing the
 * record keeps the fork out of the store's shape entirely — the keys there are
 * already namespaced strings, not bare project ids.
 */
export function sidebarConnectionGroupExpansionKey(environmentId: EnvironmentId): string {
  return `sidebar-connection-group:${environmentId}`;
}

export function resolveSidebarConnectionGroupExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  environmentId: EnvironmentId,
): boolean {
  return projectExpandedById[sidebarConnectionGroupExpansionKey(environmentId)] ?? true;
}

/**
 * Whether shift-click may select a RANGE of threads in this view.
 *
 * A range is computed over the flat key list the inbox renders, top to
 * bottom. The connections view renders the same threads in a different order
 * and pages each group separately, so a range taken there would sweep in rows
 * that are not on screen — and the bulk actions on a selection (settle,
 * snooze, delete) would then touch threads the user never saw. Ranges stay an
 * inbox affordance until the rendered order is what defines them; shift-click
 * degrades to selecting the one row it landed on.
 */
export function supportsSidebarRangeSelect(viewMode: SidebarV2ViewMode): boolean {
  return viewMode === "inbox";
}

/** The status dot's colour, same mapping the Connections settings rows use. */
export function sidebarConnectionDotClassName(
  connection: EnvironmentConnectionPresentation | null,
): string {
  switch (connection?.phase) {
    case "connected":
      return "bg-success";
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}
