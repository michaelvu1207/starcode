/**
 * The sidebar v2 connections view: one collapsible group per paired machine,
 * each holding that machine's threads.
 *
 * Fork-owned, and rows are rendered by the caller's own row renderer rather
 * than a second row component — the inbox and this view must stay the same
 * rows with the same affordances, and SidebarV2.tsx keeps a call-site-only
 * diff. All this file owns is the grouping chrome: status, name, count,
 * collapse.
 *
 * The status dot reads the live client-runtime connection phase, the same
 * source (and colours) as the dots on Settings → Connections, so a machine
 * that drops out is visibly down here without opening settings. It is only a
 * signal, not an explanation: what phase the connection is in, what it is
 * retrying, what it is spending and how fast it answers all live in the
 * connections dropdown in the header's icon strip, which is one place instead
 * of a tooltip per group.
 *
 * Group names are renameable in place: the pencil swaps the header for an
 * input, and the alias it writes is the same one Settings → Connections edits.
 * The header is a button, so the pencil is its sibling rather than its child.
 *
 * Beside the dot, the machine's own mark (`ConnectionMark`) — a computer in a
 * colour derived from the environment id. The dot and the mark answer different
 * questions and neither substitutes for the other: the dot is *how is it*, and
 * changes; the mark is *which one is it*, and never does.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { usePrimaryEnvironmentId, useEnvironments } from "../../state/environments";
import {
  SIDEBAR_CONNECTION_ROWS_INITIAL_COUNT,
  SIDEBAR_CONNECTION_ROWS_PAGE_COUNT,
  buildSidebarConnectionGroups,
  limitSidebarConnectionRows,
  resolveSidebarConnectionGroupExpanded,
  sidebarConnectionDotClassName,
  sidebarConnectionGroupExpansionKey,
} from "../Sidebar.connections";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ConnectionNameInput, ConnectionRenameTrigger } from "../ConnectionNameEditor";
import { ConnectionMark } from "./ConnectionMark";
import { SidebarImportConversationRow } from "./SidebarImportConversationRow";
import { StarcodeMark } from "../brand/StarcodeWordmark";

export function SidebarConnectionsView(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly routeThreadKey: string | null;
  readonly renderThreadRow: (thread: EnvironmentThreadShell) => ReactNode;
}): ReactNode {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  // Paging is per group and lives in component state on purpose: how deep you
  // scrolled into one machine's history is not worth persisting, and it resets
  // when the view does.
  const [visibleCountByEnvironment, setVisibleCountByEnvironment] = useState<
    Readonly<Record<string, number>>
  >({});
  // One group at a time is being renamed, and the edit dies with the view.
  const [renamingEnvironmentId, setRenamingEnvironmentId] = useState<EnvironmentId | null>(null);
  const groups = useMemo(
    () =>
      buildSidebarConnectionGroups({
        threads: props.threads,
        environments,
        primaryEnvironmentId,
      }),
    [environments, primaryEnvironmentId, props.threads],
  );

  const toggleGroup = useCallback(
    (environmentId: EnvironmentId, expanded: boolean) => {
      setProjectExpanded(sidebarConnectionGroupExpansionKey(environmentId), !expanded);
    },
    [setProjectExpanded],
  );
  const showMore = useCallback((environmentId: EnvironmentId) => {
    setVisibleCountByEnvironment((counts) => ({
      ...counts,
      [environmentId]:
        (counts[environmentId] ?? SIDEBAR_CONNECTION_ROWS_INITIAL_COUNT) +
        SIDEBAR_CONNECTION_ROWS_PAGE_COUNT,
    }));
  }, []);

  return (
    <>
      {groups.map((group) => {
        const expanded = resolveSidebarConnectionGroupExpanded(
          projectExpandedById,
          group.environmentId,
        );
        // A collapsed group still renders the thread you are reading: the
        // chat pane and the sidebar must never disagree about what is open.
        const { rows, hiddenCount } = limitSidebarConnectionRows(
          group.rows,
          expanded
            ? (visibleCountByEnvironment[group.environmentId] ??
                SIDEBAR_CONNECTION_ROWS_INITIAL_COUNT)
            : 0,
          props.routeThreadKey,
        );
        return (
          <Fragment key={group.environmentId}>
            <li
              data-thread-selection-safe
              className="list-none"
              data-testid="sidebar-v2-connection-group"
              data-environment-id={group.environmentId}
            >
              <div className="group/machine mb-0.5 mt-5 flex items-center gap-1.5 px-2.5">
                {renamingEnvironmentId === group.environmentId ? (
                  <>
                    {/* The chevron and the mark are here too, so nothing shifts
                        sideways the moment you start typing in the header. */}
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground/60",
                        expanded && "rotate-90",
                      )}
                    />
                    <ConnectionStatusDot
                      dotClassName={sidebarConnectionDotClassName(group.connection)}
                    />
                    <ConnectionMark environmentId={group.environmentId} className="size-4" />
                    <ConnectionNameInput
                      environmentId={group.environmentId}
                      serverLabel={group.serverLabel}
                      className="h-7 text-sm"
                      onDone={() => setRenamingEnvironmentId(null)}
                    />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.environmentId, expanded)}
                      aria-expanded={expanded}
                      data-testid="sidebar-v2-connection-group-toggle"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                    >
                      {/* Same header grammar as the projects view — leading
                          disclosure, name at section weight. The two views are
                          the same list grouped two ways, and a machine heading
                          that read smaller than a project heading would imply a
                          hierarchy between them that does not exist. */}
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
                          expanded && "rotate-90",
                        )}
                      />
                      <ConnectionStatusDot
                        dotClassName={sidebarConnectionDotClassName(group.connection)}
                        pingClassName={
                          group.connection?.phase === "connecting" ||
                          group.connection?.phase === "reconnecting"
                            ? "bg-warning/60 duration-2000"
                            : null
                        }
                      />
                      <ConnectionMark environmentId={group.environmentId} className="size-4" />
                      <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-sidebar-foreground">
                        {group.label}
                      </span>
                      {group.isOwnBackend ? (
                        // Not "Local": the paired hub on this same laptop is
                        // local too, and telling them apart is the whole point.
                        // Threads here are reachable from this app and nothing
                        // else — no browser tab, no other machine.
                        <span
                          data-testid="connection-own-backend"
                          title="This app's own backend — threads here are visible only in this app"
                          className="shrink-0 rounded-sm bg-muted/60 px-1 text-[10px] text-muted-foreground/70"
                        >
                          this app
                        </span>
                      ) : group.isLocal ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">Local</span>
                      ) : null}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground/45">
                        {group.rows.length}
                      </span>
                      <span className="flex-1" />
                    </button>
                    {/* Only for machines still in the catalog: a group left
                        behind by a removed connection has nothing to alias. */}
                    {group.connection === null ? null : (
                      <ConnectionRenameTrigger
                        displayName={group.label}
                        className="opacity-0 focus-visible:opacity-100 group-hover/machine:opacity-100"
                        onStart={() => setRenamingEnvironmentId(group.environmentId)}
                      />
                    )}
                  </>
                )}
              </div>
            </li>
            {expanded && group.rows.length === 0 ? (
              <li className="flex list-none items-center gap-1.5 px-2.5 pb-1 text-[11px] text-muted-foreground/50">
                <StarcodeMark className="size-3 shrink-0 text-muted-foreground/45" />
                No threads yet
              </li>
            ) : null}
            {rows.map((row) => props.renderThreadRow(row))}
            {expanded && hiddenCount > 0 ? (
              <li className="list-none">
                <button
                  type="button"
                  onClick={() => showMore(group.environmentId)}
                  className="mt-1 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
                >
                  Show {Math.min(hiddenCount, SIDEBAR_CONNECTION_ROWS_PAGE_COUNT)} more
                  <span className="text-muted-foreground/50">({hiddenCount} hidden)</span>
                </button>
              </li>
            ) : null}
            {/* Below the machine's starcode threads: the other history, the
                one the CLIs kept on their own. It used to be a strip you could
                browse and read; now it is one door into the import picker,
                because a conversation you cannot resume is not worth the
                sidebar space. Only for machines still in the catalog — a group
                left behind by a removed connection has nothing to import from. */}
            {expanded && group.connection !== null ? (
              <SidebarImportConversationRow environmentId={group.environmentId} />
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}
