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
 * that drops out is visibly down here without opening settings.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
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
  type SidebarConnectionSection,
} from "../Sidebar.connections";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { SidebarTerminalHistoryStrip } from "./SidebarTerminalHistoryStrip";

export function SidebarConnectionsView(props: {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly routeThreadKey: string | null;
  readonly renderThreadRow: (
    thread: EnvironmentThreadShell,
    section: SidebarConnectionSection,
  ) => ReactNode;
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

  const groups = useMemo(
    () =>
      buildSidebarConnectionGroups({
        activeThreads: props.activeThreads,
        snoozedThreads: props.snoozedThreads,
        settledThreads: props.settledThreads,
        environments,
        primaryEnvironmentId,
      }),
    [
      environments,
      primaryEnvironmentId,
      props.activeThreads,
      props.settledThreads,
      props.snoozedThreads,
    ],
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
              <button
                type="button"
                onClick={() => toggleGroup(group.environmentId, expanded)}
                aria-expanded={expanded}
                data-testid="sidebar-v2-connection-group-toggle"
                className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
              >
                <ConnectionStatusDot
                  tooltipText={
                    group.connection === null
                      ? "Not connected. This machine is no longer one of your connections."
                      : connectionStatusText(group.connection)
                  }
                  dotClassName={sidebarConnectionDotClassName(group.connection)}
                  pingClassName={
                    group.connection?.phase === "connecting" ||
                    group.connection?.phase === "reconnecting"
                      ? "bg-warning/60 duration-2000"
                      : null
                  }
                />
                <span className="min-w-0 truncate text-xs font-medium text-sidebar-foreground/80">
                  {group.label}
                </span>
                {group.isLocal ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">Local</span>
                ) : null}
                <span className="h-px flex-1 bg-sidebar-border/60" />
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">
                  {group.rows.length}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3 text-muted-foreground/50 transition-transform",
                    expanded && "rotate-180",
                  )}
                />
              </button>
            </li>
            {expanded && group.rows.length === 0 ? (
              <li className="list-none px-2.5 pb-1 text-[11px] text-muted-foreground/50">
                No threads yet
              </li>
            ) : null}
            {rows.map((row) => props.renderThreadRow(row.thread, row.section))}
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
            {/* Below the machine's t3 threads: this is the other history, the
                one the CLIs kept on their own. */}
            {expanded ? (
              <SidebarTerminalHistoryStrip
                environmentId={group.environmentId}
                groupExpanded={expanded}
              />
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}
