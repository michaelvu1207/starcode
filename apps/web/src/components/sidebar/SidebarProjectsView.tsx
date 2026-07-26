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
 * The header expands and collapses. The map beside it opens the project's
 * home at `/projects/$slug`, where the masters, the lineage sky and the
 * per-project workbench live — a map glyph because a star map is literally what
 * is behind it. Making the header itself navigate would put the one
 * destructive-to-your-scroll-position action on the target you hit forty times
 * a day.
 *
 * What is NOT here: any inbox. No attention badges, no needs-attention rollup,
 * no ranking. This view is your projects and their threads; triage is the inbox
 * view's job and it is one menu away. Threads no project claims land in a
 * "Chats" section at the very bottom, under everything including the archived
 * disclosure, with the filing popover on its header.
 *
 * Also NOT here: any second opinion about which project a thread belongs to.
 * Membership arrives resolved from the F16 fold, the same answer `/projects`
 * shows, and the machine a thread runs on stays a detail on the row.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectCategorySlug } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, MapIcon } from "lucide-react";
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
import { useProjectThreadStarter } from "../projects/useProjectThreadStarter";
import {
  resolveProjectStartLocations,
  type ProjectStartFolder,
  type ProjectStartLocation,
} from "../projects/ProjectThreadStart.model";
import type { ProjectSeedProposal } from "../projects/ProjectCatalog.model";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SidebarProjectNewThread } from "./SidebarProjectNewThread";
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverProjects = useProjects();
  const startThread = useProjectThreadStarter();
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

  const { groups, archivedGroups, chatsGroup } = useMemo(
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
  // Live projects only: filing into an archived project would un-hide it on the
  // next render, which is not what "file this here" is asking for.
  const fileableProjects = groups;

  // Every folder every machine reports, in the shape the start-location ranking
  // wants. Built once for the view rather than once per project group: the list
  // is the same for all of them and only the ranking differs.
  const startFolders = useMemo(
    (): ReadonlyArray<ProjectStartFolder> =>
      serverProjects.map((serverProject) => ({
        environmentId: serverProject.environmentId,
        projectId: serverProject.id,
        title: serverProject.title,
        machineLabel: environmentLabelById.get(serverProject.environmentId) ?? "",
        isLocalMachine: serverProject.environmentId === primaryEnvironmentId,
      })),
    [environmentLabelById, primaryEnvironmentId, serverProjects],
  );
  const projectBySlug = useMemo(
    () => new Map(view.projects.map((project) => [project.slug, project])),
    [view.projects],
  );

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

  const startLocationsFor = (slug: ProjectCategorySlug): ReadonlyArray<ProjectStartLocation> => {
    const project = projectBySlug.get(slug);
    if (project === undefined) return [];
    return resolveProjectStartLocations({ project, folders: startFolders });
  };

  /**
   * What a group actually shows, once collapse and paging are applied.
   *
   * Shared by the project groups and the docked Chats section so the one rule
   * that matters here cannot drift between them: a collapsed group still
   * renders the thread you are reading, because the chat pane and the sidebar
   * must never disagree about what is open.
   */
  const visibleRowsFor = (group: SidebarProjectGroup) => {
    const expanded = resolveSidebarProjectGroupExpanded(projectExpandedById, group.key);
    const { rows, hiddenCount } = limitSidebarProjectRows(
      group.rows,
      expanded ? (visibleCountByGroup[group.key] ?? SIDEBAR_PROJECT_ROWS_INITIAL_COUNT) : 0,
      props.routeThreadKey,
    );
    return { expanded, rows, hiddenCount };
  };

  const renderShowMore = (group: SidebarProjectGroup, hiddenCount: number): ReactNode => (
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
  );

  const renderGroup = (group: SidebarProjectGroup): ReactNode => {
    const { expanded, rows, hiddenCount } = visibleRowsFor(group);
    return (
      <Fragment key={group.key}>
        <li
          data-thread-selection-safe
          className="list-none"
          data-testid="sidebar-v2-project-group"
          data-project-slug={group.slug ?? SIDEBAR_UNFILED_GROUP_KEY}
        >
          {/* A heading, not a label. The threads below are this project's, and
              the name is set two steps larger and heavier than the rows it
              governs so it says so at a glance.
              No disclosure triangle: the whole heading is the toggle, and a
              column of chevrons down the left edge was reading as chrome in a
              list whose left edge is otherwise the project's own glyph. The
              button keeps `aria-expanded`, and carries a title so the hover
              still tells you the heading opens and closes. */}
          <div className="group/project mb-0.5 mt-5 flex items-center gap-1.5 px-2.5">
            <button
              type="button"
              onClick={() => toggleGroup(group.key, expanded)}
              aria-expanded={expanded}
              title={`${expanded ? "Collapse" : "Expand"} ${group.title}`}
              data-testid="sidebar-v2-project-group-toggle"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
            >
              {group.slug === null ? (
                // The Chats group is not a project and does not pretend to
                // be one: no constellation, no accent, just a mark that reads
                // as "these have no home yet".
                <span
                  aria-hidden
                  className="size-3.5 shrink-0 rounded-[3px] border border-dashed border-muted-foreground/40"
                />
              ) : (
                <span
                  className="sc-project-mark size-4 shrink-0"
                  style={
                    {
                      "--sc-project-hue": `${projectAccentHue(group.key, group.accent)}deg`,
                    } as never
                  }
                >
                  <ProjectGlyph slug={group.key} variant={group.glyph} />
                </span>
              )}
              <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-sidebar-foreground">
                {group.title}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/45">
                {group.rows.length}
              </span>
              <span className="flex-1" />
            </button>
            {group.slug === null ? (
              <SidebarUnfiledTriage
                threads={group.rows.map((row) => row.thread)}
                projects={fileableProjects}
                environmentLabelById={environmentLabelById}
              />
            ) : (
              <>
                <SidebarProjectNewThread
                  slug={group.slug}
                  title={group.title}
                  locations={startLocationsFor(group.slug)}
                  onStart={(slug, location) => void startThread(slug, location)}
                />
                <Link
                  to="/projects/$slug"
                  params={{ slug: group.slug }}
                  aria-label={`Open ${group.title}`}
                  title={`Open ${group.title}`}
                  data-testid="sidebar-v2-project-group-open"
                  className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/50 opacity-0 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/project:opacity-100"
                >
                  <MapIcon aria-hidden className="size-3" />
                </Link>
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
        {rows.map((row) => props.renderThreadRow(row.thread, row.section))}
        {expanded && hiddenCount > 0 ? renderShowMore(group, hiddenCount) : null}
      </Fragment>
    );
  };

  /**
   * Chats, docked to the bottom of the sidebar.
   *
   * Not the last item in the list — the bottom of the *viewport*. `mt-auto`
   * hugs it to the floor when the projects are short (the list is given a
   * full-height minimum for exactly this), and `sticky bottom-0` holds it there
   * once they are long enough to scroll. Threads with no home are the pile you
   * work off, so it has to be somewhere your eye can always find without
   * scrolling to the end of everything else.
   *
   * The rows go in a nested list with its own scroll, capped so a hundred loose
   * threads cannot eat the projects above them. Nesting is safe here: thread
   * selection resolves through `closest()`, not through direct children.
   *
   * It needs the sidebar's own background AND its grain — rows scroll under
   * this, and a plain `bg-sidebar` panel over a grained surface leaves a seam
   * exactly at the line where the texture stops.
   */
  const renderChatsSection = (group: SidebarProjectGroup): ReactNode => {
    const { expanded, rows, hiddenCount } = visibleRowsFor(group);
    return (
      <li
        data-thread-selection-safe
        data-testid="sidebar-v2-chats-dock"
        className="sticky bottom-0 z-10 mt-auto list-none bg-sidebar surface-grain pb-1"
      >
        <div className="relative">
          <button
            type="button"
            onClick={() => toggleGroup(group.key, expanded)}
            aria-expanded={expanded}
            title={expanded ? "Collapse Chats" : "Expand Chats"}
            data-testid="sidebar-v2-chats-toggle"
            className="starcode-section-rule w-full cursor-pointer px-2.5 pb-1.5 pt-3 text-center"
          >
            <span className="text-[13px] font-semibold tracking-[0.14em] text-sidebar-foreground/70 uppercase">
              Chats
            </span>
          </button>
          {/* Absolutely placed so the engraved rule stays centred on the title
              rather than on the title plus a button. */}
          <span className="absolute bottom-1.5 right-2.5">
            <SidebarUnfiledTriage
              threads={group.rows.map((row) => row.thread)}
              projects={fileableProjects}
              environmentLabelById={environmentLabelById}
            />
          </span>
        </div>
        {expanded ? (
          <div className="max-h-[38vh] overflow-y-auto">
            <ul role="list" className="flex flex-col gap-px">
              {rows.map((row) => props.renderThreadRow(row.thread, row.section))}
              {hiddenCount > 0 ? renderShowMore(group, hiddenCount) : null}
            </ul>
          </div>
        ) : null}
      </li>
    );
  };

  const archivedThreadCount = countSidebarProjectRows(archivedGroups);

  return (
    <>
      {/* The two section headings this view has, and the only two engraved
          rules in the app outside a dialog. They exist because the list now has
          two halves that answer different questions — what you organised, and
          what you have not — and a docked panel at the bottom needs something
          at the top saying what the rest of the list is. Centred and engraved
          rather than a left-aligned label, so they read as chapter marks over
          the headings rather than as one more heading among them. */}
      <li data-thread-selection-safe className="list-none">
        <div
          data-testid="sidebar-v2-projects-heading"
          className="starcode-section-rule px-2.5 pb-1 pt-1 text-center"
        >
          <span className="text-[13px] font-semibold tracking-[0.14em] text-sidebar-foreground/70 uppercase">
            Projects
          </span>
        </div>
      </li>

      {/* The invitation shows whenever no project exists — NOT only when the
          list is empty. Before you have filed anything every thread is in
          Chats, so the view is never empty, and gating this on "nothing to
          show" would leave the one view that is about projects with no way to
          make one. Chats still renders below it. */}
      {groups.length === 0 ? (
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

      {/* Chats is docked to the bottom of the viewport rather than laid after
          the archived disclosure — see `renderChatsSection`. The projects are
          the point of this view and they get the top of it; the threads with no
          home get a floor you can always see. */}
      {chatsGroup === null ? null : renderChatsSection(chatsGroup)}

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
