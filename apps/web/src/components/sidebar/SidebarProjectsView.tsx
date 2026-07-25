/**
 * The sidebar v2 projects view: one collapsible group per project, each holding
 * that project's threads from every machine at once.
 *
 * Built to the shape the connections view established — fork-owned, rows
 * rendered by the caller's own renderer rather than a second row component, so
 * `SidebarV2.tsx` keeps a call-site-only diff and the inbox and this view can
 * only ever disagree about layout. All this file owns is the grouping chrome:
 * glyph, name, attention, count, collapse.
 *
 * Two affordances share the header and they are deliberately separate targets,
 * which is the same problem the connections view solved with its rename pencil.
 * The header expands and collapses. The arrow beside it opens the project's
 * home at `/projects/$slug`, where the masters, the lineage sky and the
 * per-project workbench live. Making the header itself navigate would put the
 * one destructive-to-your-scroll-position action on the target you hit forty
 * times a day.
 *
 * What is NOT here: any second opinion about which project a thread belongs to.
 * Membership arrives resolved from the F16 fold, the same answer `/projects`
 * shows, and the machine a thread runs on stays a detail on the row.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { useEnvironments } from "../../state/environments";
import {
  useProjectCatalogView,
  useProjectMembership,
  useProjectSeedPlan,
} from "../../state/projectCatalog";
import { ProjectGlyph } from "../projects/ProjectGlyph";
import { ProjectSeedDialog } from "../projects/ProjectSeedDialog";
import { projectAccentHue } from "../projects/ProjectsIndex.model";
import { useProjectWriter } from "../projects/useProjectWriter";
import type { ProjectSeedProposal } from "../projects/ProjectCatalog.model";
import {
  SIDEBAR_PROJECT_ROWS_INITIAL_COUNT,
  SIDEBAR_PROJECT_ROWS_PAGE_COUNT,
  SIDEBAR_UNFILED_GROUP_KEY,
  buildSidebarProjectGroups,
  countSidebarProjectRows,
  limitSidebarProjectRows,
  resolveSidebarProjectGroupExpanded,
  sidebarProjectGroupExpansionKey,
  type SidebarProjectGroup,
  type SidebarProjectSection,
} from "../Sidebar.projects";
import { SidebarUnfiledTriage } from "./SidebarUnfiledTriage";
import { StarcodeMark } from "../brand/StarcodeWordmark";
import "../projects/Projects.css";

export function SidebarProjectsView(props: {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly settledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly routeThreadKey: string | null;
  readonly renderThreadRow: (
    thread: EnvironmentThreadShell,
    section: SidebarProjectSection,
  ) => ReactNode;
}): ReactNode {
  const view = useProjectCatalogView();
  const membership = useProjectMembership(view);
  const seedPlan = useProjectSeedPlan(view);
  const writer = useProjectWriter();
  const { environments } = useEnvironments();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  // Paging is per group and lives in component state for the same reason the
  // connections view keeps it there: how deep you scrolled into one project's
  // history is not worth persisting.
  const [visibleCountByGroup, setVisibleCountByGroup] = useState<Readonly<Record<string, number>>>(
    {},
  );
  const [showArchived, setShowArchived] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const { groups, archivedGroups } = useMemo(
    () =>
      buildSidebarProjectGroups({
        activeThreads: props.activeThreads,
        snoozedThreads: props.snoozedThreads,
        settledThreads: props.settledThreads,
        projects: view.projects,
        membership,
      }),
    [membership, props.activeThreads, props.settledThreads, props.snoozedThreads, view.projects],
  );

  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const fileableProjects = useMemo(() => groups.filter((group) => group.slug !== null), [groups]);

  const toggleGroup = useCallback(
    (groupKey: string, expanded: boolean) => {
      setProjectExpanded(sidebarProjectGroupExpansionKey(groupKey), !expanded);
    },
    [setProjectExpanded],
  );
  const showMore = useCallback((groupKey: string) => {
    setVisibleCountByGroup((counts) => ({
      ...counts,
      [groupKey]:
        (counts[groupKey] ?? SIDEBAR_PROJECT_ROWS_INITIAL_COUNT) + SIDEBAR_PROJECT_ROWS_PAGE_COUNT,
    }));
  }, []);

  const runSeed = useCallback(
    async (accepted: ReadonlyArray<ProjectSeedProposal>) => {
      setSeeding(true);
      try {
        await writer.seed(accepted);
        setSeedOpen(false);
      } finally {
        setSeeding(false);
      }
    },
    [writer],
  );

  const renderGroup = (group: SidebarProjectGroup): ReactNode => {
    const expanded = resolveSidebarProjectGroupExpanded(projectExpandedById, group.key);
    // A collapsed group still renders the thread you are reading: the chat
    // pane and the sidebar must never disagree about what is open.
    const { rows, hiddenCount } = limitSidebarProjectRows(
      group.rows,
      expanded ? (visibleCountByGroup[group.key] ?? SIDEBAR_PROJECT_ROWS_INITIAL_COUNT) : 0,
      props.routeThreadKey,
    );
    return (
      <Fragment key={group.key}>
        <li
          data-thread-selection-safe
          className="list-none"
          data-testid="sidebar-v2-project-group"
          data-project-slug={group.slug ?? SIDEBAR_UNFILED_GROUP_KEY}
        >
          <div className="group/project mb-1 mt-3 flex items-center gap-1.5 px-2.5">
            <button
              type="button"
              onClick={() => toggleGroup(group.key, expanded)}
              aria-expanded={expanded}
              data-testid="sidebar-v2-project-group-toggle"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            >
              {group.slug === null ? (
                // The unfiled group is not a project and does not pretend to
                // be one: no constellation, no accent, just a mark that reads
                // as "these have no home yet".
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-[3px] border border-dashed border-muted-foreground/40"
                />
              ) : (
                <span
                  className="sc-project-mark size-3.5 shrink-0"
                  style={
                    {
                      "--sc-project-hue": `${projectAccentHue(group.key, group.accent)}deg`,
                    } as never
                  }
                >
                  <ProjectGlyph slug={group.key} variant={group.glyph} />
                </span>
              )}
              <span className="min-w-0 truncate text-xs font-medium text-sidebar-foreground/80">
                {group.title}
              </span>
              {group.attentionCount > 0 ? (
                <span
                  data-testid="sidebar-v2-project-group-attention"
                  title={`${group.attentionCount} waiting on you`}
                  className="shrink-0 rounded-full bg-warning/15 px-1.5 font-mono text-[10px] leading-4 text-warning"
                >
                  {group.attentionCount}
                </span>
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
            {group.slug === null ? (
              <SidebarUnfiledTriage
                threads={group.rows.map((row) => row.thread)}
                projects={fileableProjects}
                environmentLabelById={environmentLabelById}
              />
            ) : (
              <Link
                to="/projects/$slug"
                params={{ slug: group.slug }}
                aria-label={`Open ${group.title}`}
                title={`Open ${group.title}`}
                data-testid="sidebar-v2-project-group-open"
                className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/50 opacity-0 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/project:opacity-100"
              >
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </Link>
            )}
          </div>
        </li>
        {expanded && group.rows.length === 0 ? (
          <li className="flex list-none items-center gap-1.5 px-2.5 pb-1 text-[11px] text-muted-foreground/50">
            <StarcodeMark className="size-3 shrink-0 text-muted-foreground/45" />
            No threads yet
          </li>
        ) : null}
        {rows.map((row) => props.renderThreadRow(row.thread, row.section))}
        {expanded && hiddenCount > 0 ? (
          <li className="list-none">
            <button
              type="button"
              onClick={() => showMore(group.key)}
              className="mt-1 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
            >
              Show {Math.min(hiddenCount, SIDEBAR_PROJECT_ROWS_PAGE_COUNT)} more
              <span className="text-muted-foreground/50">({hiddenCount} hidden)</span>
            </button>
          </li>
        ) : null}
      </Fragment>
    );
  };

  const archivedThreadCount = countSidebarProjectRows(archivedGroups);

  return (
    <>
      {/* The invitation shows whenever no project exists — NOT only when the
          list is empty. Before you have filed anything, every thread is
          unfiled, so the list is never empty and keying the empty state off
          `groups.length` would leave the one view that is about projects with
          no way to make one. The unfiled group still renders below it. */}
      {fileableProjects.length === 0 ? (
        <li className="list-none px-2.5 py-6 text-center text-xs text-muted-foreground/60">
          <p className="mb-2">No projects yet</p>
          <p className="mb-3 text-[11px] text-muted-foreground/50">
            A project gathers threads from every machine under one name.
          </p>
          {seedPlan.proposals.length > 0 ? (
            <button
              type="button"
              onClick={() => setSeedOpen(true)}
              data-testid="sidebar-v2-project-seed"
              className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              Set up {seedPlan.proposals.length}
            </button>
          ) : (
            <Link
              to="/projects"
              data-testid="sidebar-v2-project-empty-link"
              className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              Open projects
            </Link>
          )}
        </li>
      ) : null}
      {groups.map(renderGroup)}

      {/* Archived projects sit behind a disclosure the way the index's do. The
          thread count is on the label on purpose: collapsing a group must never
          be the same thing as losing track of work, so the sidebar says how
          much is behind the door. */}
      {archivedGroups.length > 0 ? (
        <li data-thread-selection-safe className="list-none">
          <button
            type="button"
            onClick={() => setShowArchived((current) => !current)}
            aria-expanded={showArchived}
            data-testid="sidebar-v2-project-archived-toggle"
            className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-1.5 px-2.5 text-left text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", showArchived && "rotate-90")}
            />
            {archivedGroups.length} archived
            {archivedThreadCount > 0 ? (
              <span className="text-muted-foreground/40">
                ({archivedThreadCount} {archivedThreadCount === 1 ? "thread" : "threads"})
              </span>
            ) : null}
          </button>
        </li>
      ) : null}
      {showArchived ? archivedGroups.map(renderGroup) : null}

      <ProjectSeedDialog
        open={seedOpen}
        onOpenChange={setSeedOpen}
        proposals={seedPlan.proposals}
        onSeed={(accepted) => void runSeed(accepted)}
        seeding={seeding}
      />
    </>
  );
}
