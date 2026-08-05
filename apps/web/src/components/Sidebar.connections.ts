/**
 * The sidebar v2 connections view: the same threads the inbox shows, regrouped
 * under the machine that runs them.
 *
 * The grouping is deliberately a fold over the inbox's own list rather than a
 * second pass over the raw shells: a separate filter would drift from the
 * inbox the first time either changes. Feed it what the inbox renders and the
 * two views can only ever disagree about layout.
 *
 * Order inside a group is the inbox's order, preserved — ranked by attention,
 * or by creation when the user opted out. Order OF the
 * groups is local first — it is the machine you are sitting at — then by the
 * name the machine announces for itself, which never moves under you the way
 * an activity ranking would. Deliberately not the displayed name: that one is
 * renameable in place from this very header, and ordering by it would slide
 * the group away the instant the rename lands.
 */
import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import type { EnvironmentConnectionPresentation } from "@starcode/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@starcode/client-runtime/environment";
import type { EnvironmentId, SidebarV2ViewMode } from "@starcode/contracts";

/** How many rows a group shows before it asks. Groups are collapsible and a
    hub sees every machine's history at once, so the cap is per group. */
export const SIDEBAR_CONNECTION_ROWS_INITIAL_COUNT = 25;
export const SIDEBAR_CONNECTION_ROWS_PAGE_COUNT = 25;

/** Narrower than the EnvironmentPresentation the caller holds: a group asks a
    connection for its name and whether it is up, nothing else. */
export interface SidebarConnectionEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The name the machine announces for itself. Sorts the groups, and is the
      placeholder the rename field offers. */
  readonly serverLabel: string;
  /** This client's own embedded backend; see `EnvironmentPresentation`. */
  readonly isOwnBackend: boolean;
  readonly connection: EnvironmentConnectionPresentation;
}

export interface SidebarConnectionGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Carried through so the header's rename field can offer it as the
      placeholder without the view rebuilding its own id-to-label map. */
  readonly serverLabel: string;
  /** The environment this client is itself hosted by, if any. */
  readonly isLocal: boolean;
  /** This client's own embedded backend; see `EnvironmentPresentation`. */
  readonly isOwnBackend: boolean;
  /** `null` when the environment is not in the catalog at all — a thread cached
      from a connection that has since been removed. Its rows still render:
      hiding threads is the one thing this view must never do. */
  readonly connection: EnvironmentConnectionPresentation | null;
  readonly rows: ReadonlyArray<EnvironmentThreadShell>;
}

export interface SidebarConnectionsInput {
  /** The inbox list, already filtered and ordered; grouping only re-buckets it. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environments: ReadonlyArray<SidebarConnectionEnvironment>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}

export function buildSidebarConnectionGroups(
  input: SidebarConnectionsInput,
): ReadonlyArray<SidebarConnectionGroup> {
  const rowsByEnvironment = new Map<EnvironmentId, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    const rows = rowsByEnvironment.get(thread.environmentId);
    if (rows === undefined) {
      rowsByEnvironment.set(thread.environmentId, [thread]);
    } else {
      rows.push(thread);
    }
  }

  const groups: SidebarConnectionGroup[] = input.environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverLabel: environment.serverLabel,
    isLocal: environment.environmentId === input.primaryEnvironmentId,
    isOwnBackend: environment.isOwnBackend,
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
      serverLabel: environmentId,
      isLocal: environmentId === input.primaryEnvironmentId,
      isOwnBackend: false,
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
      left.serverLabel.localeCompare(right.serverLabel) ||
      left.environmentId.localeCompare(right.environmentId)
    );
  });
}

/**
 * The visible slice of a group. The thread open in the chat pane is never the
 * one hidden behind "show more", or its highlight and affordances would be
 * unreachable.
 */
export function limitSidebarConnectionRows(
  rows: ReadonlyArray<EnvironmentThreadShell>,
  visibleCount: number,
  routeThreadKey: string | null,
): { readonly rows: ReadonlyArray<EnvironmentThreadShell>; readonly hiddenCount: number } {
  if (rows.length <= visibleCount) return { rows, hiddenCount: 0 };
  const visible = rows.slice(0, visibleCount);
  if (routeThreadKey !== null) {
    const routeRow = rows
      .slice(visibleCount)
      .find((row) => scopedThreadKey(scopeThreadRef(row.environmentId, row.id)) === routeThreadKey);
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
 * that are not on screen — and the bulk actions on a selection (mark unread,
 * delete) would then touch threads the user never saw. Ranges stay an
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
