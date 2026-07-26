/**
 * `/projects/$slug` — one project, everywhere it lives.
 *
 * The Workbench's sky with a membership filter and a header, which is the whole
 * point of the seam F14 left: the fleet view and a project view are the same
 * picture drawn over different sets, not two implementations of a star map.
 *
 * Three regions, in reading order: what this project *is* (header, editable),
 * what its work looks like right now (the sky), and the threads themselves as a
 * list you can click. The list is not redundant with the sky — the sky answers
 * "what shape is this project in", the list answers "take me to that thread",
 * and asking a constellation to be a table is how both stop working.
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ProjectCategorySlug,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArchiveIcon, ArrowLeftIcon, CompassIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActivities, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useFeatureMapByEnvironment } from "../../state/featureFlow";
import { useProjectCatalogView, useProjectMembership } from "../../state/projectCatalog";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { resolveSidebarV2Status } from "../Sidebar.logic";
import { Button } from "../ui/button";
import type { SkyMaster, SkyProjectScope } from "../workbench/StarMap.model";
import {
  collectMasterCreatedThreadIds,
  resolveWorkbenchMaster,
} from "../workbench/Workbench.master";
import { WorkbenchMasterPane } from "../workbench/WorkbenchMasterPane";
import { WorkbenchStarMap } from "../workbench/WorkbenchStarMap";
import {
  WORKBENCH_TONE_DOT_CLASS,
  WORKBENCH_TONE_LABEL,
  toneForThreadStatus,
} from "../workbench/Workbench.tone";
import { projectMasterCandidates, projectSectionFor } from "./ProjectCatalog.model";
import { describeProjectFeatures, foldProjectFeatures } from "./ProjectFeatures.model";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { ProjectEditDialog } from "./ProjectEditDialog";
import { ProjectGlyph } from "./ProjectGlyph";
import { projectAccentHue } from "./ProjectsIndex.model";
import { useProjectWriter } from "./useProjectWriter";
import "./Projects.css";

export function ProjectHomeView({ slug }: { readonly slug: string }): ReactNode {
  const view = useProjectCatalogView();
  const membership = useProjectMembership(view);
  const threads = useThreadShells();
  const writer = useProjectWriter();
  const navigate = useNavigate();
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const { environments } = useEnvironments();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [picking, setPicking] = useState(false);
  /** `null` until the operator says; see `showMaster` for what that resolves to. */
  const [masterPaneOpen, setMasterPaneOpen] = useState<boolean | null>(null);
  const [preferredEnvironmentId, setPreferredEnvironmentId] = useState<EnvironmentId | null>(null);

  const project = view.projects.find((entry) => entry.slug === slug) ?? null;

  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );

  /**
   * This project's orchestrator, resolved through the same function the global
   * Workbench uses.
   *
   * `resolveWorkbenchMaster` takes a candidates array and nothing else, which is
   * exactly why phase 2 built `projectMasterCandidates` to produce one: the
   * fleet passes one candidate per machine's server setting, a project passes
   * one per machine's section, and neither needs the resolver to know which it
   * is. Same local-first rule, same alternates switcher, no signature change.
   */
  const { designated, alternates } = useMemo(() => {
    if (project === null) return { designated: null, alternates: [] };
    const candidates = projectMasterCandidates(project).map((candidate) => ({
      ...candidate,
      // A machine the operator switched to outranks the local one, so the pane
      // does not snap back on the next poll.
      isLocal:
        preferredEnvironmentId === null
          ? candidate.isLocal
          : candidate.environmentId === preferredEnvironmentId,
    }));
    return resolveWorkbenchMaster(candidates);
  }, [preferredEnvironmentId, project]);

  const masterThreadRef = useMemo(
    () =>
      designated === null
        ? null
        : scopeThreadRef(
            EnvironmentId.make(designated.environmentId),
            ThreadId.make(designated.threadId),
          ),
    [designated],
  );
  const masterThreadKey = masterThreadRef === null ? null : scopedThreadKey(masterThreadRef);

  const masterActivities = useThreadActivities(masterThreadRef);
  const masterCreatedThreadIds = useMemo(
    () => collectMasterCreatedThreadIds(masterActivities),
    [masterActivities],
  );

  const masterShell = useThreadShell(masterThreadRef);
  const skyMaster = useMemo((): SkyMaster | null => {
    if (designated === null || masterThreadKey === null) return null;
    return {
      key: masterThreadKey,
      threadId: designated.threadId,
      environmentId: designated.environmentId,
      machineLabel: designated.label,
      title: masterShell?.title ?? "Orchestrator",
      alive: masterShell?.latestTurn?.completedAt === null,
    };
  }, [designated, masterShell, masterThreadKey]);

  const designate = useCallback(
    (environmentId: EnvironmentId, threadId: string) => {
      if (project === null) return;
      void writer.designateMaster(project.slug, environmentId, threadId);
      setPreferredEnvironmentId(environmentId);
      setPicking(false);
    },
    [project, writer],
  );

  const clearDesignation = useCallback(() => {
    if (project === null || designated === null) return;
    void writer.designateMaster(project.slug, EnvironmentId.make(designated.environmentId), "");
    setPicking(false);
  }, [designated, project, writer]);

  /**
   * Creating this project's orchestrator, through the app's ordinary new-thread
   * flow, then claiming the id it reserved.
   *
   * The defaults come from *this project's* record rather than the machine's
   * settings — that is the difference between a project master and the global
   * one, and it is also the piece that makes a per-project orchestrator worth
   * having: plan-mode and approval-required are configuration, so an
   * orchestrator that delegates cannot write code no matter what is typed at it.
   */
  const createMaster = useCallback(
    async (projectRef: ScopedProjectRef) => {
      if (project === null) return;
      const defaults = projectSectionFor(project, projectRef.environmentId).masterDefaults;
      await handleNewThread(projectRef);
      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const target = resolveThreadRouteTarget(params);
      if (target?.kind !== "draft") return;
      const store = useComposerDraftStore.getState();
      const draft = store.getDraftThread(target.draftId);
      if (draft === null) return;
      store.setRuntimeMode(target.draftId, defaults.runtimeMode);
      store.setInteractionMode(target.draftId, defaults.interactionMode);
      designate(projectRef.environmentId, draft.threadId);
    },
    [designate, handleNewThread, project, router],
  );

  /**
   * The sky's filter, as a stable identity.
   *
   * `WorkbenchStarMap` memoises on this, so a fresh closure per render would
   * relayout the whole constellation on every keystroke elsewhere in the page.
   */
  const threadKeys = useMemo(
    () => new Set(membership.threadKeysBySlug.get(slug as ProjectCategorySlug) ?? []),
    [membership.threadKeysBySlug, slug],
  );
  const includeThreadKey = useCallback((key: string) => threadKeys.has(key), [threadKeys]);
  const scope = useMemo(
    (): SkyProjectScope => ({ slug: slug as ProjectCategorySlug, includeThreadKey }),
    [includeThreadKey, slug],
  );

  /**
   * What this project is building, gathered from every machine.
   *
   * The sky beside it draws the shape; this says the count. Both read the same
   * union, because the map is one file per server and folding them is the
   * client's job — a server that answered for another machine would be
   * inventing.
   */
  const mapEntriesByEnvironment = useFeatureMapByEnvironment();
  const featureRollup = useMemo(
    () => foldProjectFeatures({ mapEntriesByEnvironment, scope }),
    [mapEntriesByEnvironment, scope],
  );
  const featureCountByEnvironment = useMemo(
    () => new Map(featureRollup.machines.map((machine) => [machine.environmentId, machine.count])),
    [featureRollup.machines],
  );
  /**
   * Machines that never told us what they hold.
   *
   * A machine present in the map answered, even with nothing; one that is
   * absent did not. Keeping the two apart is what stops the summary below
   * asserting a count it cannot support, and the chips claiming "no features
   * here" about a machine nobody heard from. Unavailable is not empty.
   */
  const silentMachines = useMemo(
    () =>
      (project?.sections ?? [])
        .filter((section) => !mapEntriesByEnvironment.has(section.environmentId))
        .map((section) => section.label),
    [mapEntriesByEnvironment, project?.sections],
  );
  const featureSummary = describeProjectFeatures(featureRollup, silentMachines);
  /** Machines the catalog fold could not read at all — see the delete dialog. */
  const unreachableLabels = useMemo(() => view.notes.map((note) => note.label), [view.notes]);

  const rows = useMemo(
    () =>
      threads
        .filter((thread) => threadKeys.has(`${thread.environmentId}:${thread.id}`))
        .map((thread) => ({
          environmentId: thread.environmentId,
          id: thread.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
          tone: toneForThreadStatus(resolveSidebarV2Status(thread)),
        }))
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [threadKeys, threads],
  );

  if (project === null) {
    return (
      <MissingProject slug={slug} pending={view.notes.some((note) => note.reason === "pending")} />
    );
  }

  const hue = `${projectAccentHue(project.slug, project.display.accent)}deg`;
  /**
   * The orchestrator column, opened by default for a project that has one.
   *
   * It replaces the thread rail rather than joining it, so the home stays two
   * columns in both states — the Workbench's own shape when you are
   * orchestrating, and phase 3's shape when you are reading. Three columns at
   * this width would crush all of them.
   */
  const showMaster = masterPaneOpen ?? designated !== null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header
        className="relative shrink-0 overflow-hidden border-b border-border/60 px-4 py-3"
        style={{ "--sc-project-hue": hue } as never}
      >
        {/* No watermark behind this header. The first pass hung an oversized
            glyph back here; the header is ~80px tall and the mark was 136px, so
            `overflow-hidden` ate it and what survived was invisible at the
            chrome ceiling. An ornament you cannot see is not restraint, it is
            dead CSS — the marker beside the title already says which project
            this is. */}
        <div className="relative z-10 flex flex-wrap items-start gap-3">
          <Link
            to="/projects"
            className="mt-0.5 rounded p-1 text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground"
            aria-label="All projects"
          >
            <ArrowLeftIcon className="size-4" />
          </Link>
          <span className="sc-project-mark mt-px size-7 shrink-0">
            <ProjectGlyph slug={project.slug} variant={project.display.glyph} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium text-foreground">
              {project.display.title}
            </h1>
            {project.display.summary.length > 0 ? (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                {project.display.summary}
              </p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {project.sections.map((section) => {
                // Which connections carry this project, and how much of it each
                // one holds. Machines stay chips rather than becoming geography
                // — the sky beside this is deliberately connection-independent.
                const answered = mapEntriesByEnvironment.has(section.environmentId);
                const features = featureCountByEnvironment.get(section.environmentId) ?? 0;
                return (
                  <span
                    key={section.environmentId}
                    className={cn(
                      "rounded border border-border/50 px-1.5 py-px text-[10px] text-muted-foreground/70",
                      section.isLocal && "border-border text-foreground/80",
                    )}
                    title={[
                      section.local.bindings.length === 0
                        ? "Knows this project, but no folder bound here"
                        : `${section.local.bindings.length} folder(s) bound here`,
                      // "Did not say" is not "said none". Asserting the second
                      // about a machine that never answered is the lie this
                      // distinction exists to prevent.
                      !answered
                        ? "could not read what this machine is building"
                        : features === 0
                          ? "no features on this machine"
                          : `${features} feature(s) on this machine`,
                    ].join(" · ")}
                  >
                    {section.label}
                    {section.local.bindings.length === 0 ? " · no folder" : ""}
                    {answered ? (features === 0 ? "" : ` · ${features}`) : " · ?"}
                  </span>
                );
              })}
              {featureSummary === null ? null : (
                <span
                  data-testid="project-feature-rollup"
                  className="text-[10px] text-muted-foreground/60"
                >
                  {featureSummary}
                </span>
              )}
              {/* Drift, stated. A machine that missed a rename is not an error
                  — it heals on the next write — but silently showing one title
                  while another machine shows a different one is worse. */}
              {project.staleEnvironmentIds.length > 0 ? (
                <span className="text-[10px] text-muted-foreground/55">
                  {project.staleEnvironmentIds.length} machine
                  {project.staleEnvironmentIds.length === 1 ? "" : "s"} still on an older name
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMasterPaneOpen(!showMaster)}
              data-testid="project-master-toggle"
              className={cn(showMaster && "text-foreground")}
            >
              <CompassIcon className="size-3.5" />
              {designated === null ? "Set orchestrator" : "Orchestrator"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <PencilIcon className="size-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void writer.setArchived(project.slug, !project.archived).then(() => {
                  if (!project.archived) void navigate({ to: "/projects" });
                });
              }}
            >
              <ArchiveIcon className="size-3.5" />
              {project.archived ? "Unarchive" : "Archive"}
            </Button>
            {/* Delete sits beside Archive because they are the same decision at
                two strengths, and seeing both is what makes archive the obvious
                choice for "I am done with this for now". Only the project home
                carries it: the sidebar header is a target you hit forty times a
                day and is the wrong place for the one action that cannot be
                undone. */}
            <Button
              size="sm"
              variant="ghost"
              data-testid="project-delete"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2Icon className="size-3.5" />
              Delete
            </Button>
          </div>
        </div>

        {project.display.links.length > 0 ? (
          <div className="relative z-10 mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {project.display.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
              >
                {link.label}
              </a>
            ))}
          </div>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-row">
        {showMaster ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-b border-border/60 xl:w-[30rem] xl:flex-none xl:border-b-0 xl:border-r">
            <WorkbenchMasterPane
              designation={designated}
              alternates={alternates}
              picking={picking}
              onTogglePicking={() => setPicking((current) => !current)}
              onSelectAlternate={(alternate) =>
                setPreferredEnvironmentId(EnvironmentId.make(alternate.environmentId))
              }
              onDesignate={designate}
              onCreate={(projectRef) => void createMaster(projectRef)}
              onClear={clearDesignation}
            />
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkbenchStarMap
            masterThreadKey={masterThreadKey}
            master={skyMaster}
            masterCreatedThreadIds={masterCreatedThreadIds}
            scope={scope}
            emptyLabel="Nothing is filed here yet. Bind a folder to this project and its threads appear, or file one from the thread itself."
          />
        </div>

        <aside
          className={cn(
            "flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-border/60 xl:w-80 xl:border-l xl:border-t-0",
            showMaster && "hidden",
          )}
        >
          <header className="flex shrink-0 items-baseline gap-2 border-b border-border/60 px-3 py-2">
            <h2 className="text-xs font-medium text-foreground">Threads</h2>
            <span className="text-[11px] text-muted-foreground/60">{rows.length}</span>
          </header>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <li className="px-3 py-4 text-[11px] text-muted-foreground/60">
                No threads in this project yet.
              </li>
            ) : (
              rows.map((row) => (
                <li key={`${row.environmentId}:${row.id}`}>
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(
                      scopeThreadRef(EnvironmentId.make(row.environmentId), ThreadId.make(row.id)),
                    )}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        WORKBENCH_TONE_DOT_CLASS[row.tone],
                      )}
                      title={WORKBENCH_TONE_LABEL[row.tone]}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {row.title}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </aside>
      </div>

      <ProjectEditDialog
        open={editing}
        onOpenChange={setEditing}
        project={project}
        onSave={(patch) => writer.rename(project.slug, patch)}
      />

      <ProjectDeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        slug={project.slug}
        title={project.display.title}
        threadCount={threadKeys.size}
        // Every machine the fold could not read, not just the ones carrying
        // this project: a machine that did not answer cannot be asked whether
        // it holds the category, and reporting the count as if it could is the
        // claim invariant 12 forbids.
        unreachableLabels={unreachableLabels}
        environmentLabelById={environmentLabelById}
        onDelete={writer.remove}
        onDeleted={() => void navigate({ to: "/projects" })}
      />
    </div>
  );
}

/**
 * A slug nothing answers for.
 *
 * Two very different situations behind one URL: a project that was removed, and
 * a project whose only machine has not answered yet. Saying "not found" during
 * the second would be a lie that costs an operator a reload.
 */
function MissingProject({
  slug,
  pending,
}: {
  readonly slug: string;
  readonly pending: boolean;
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <p className="text-sm text-muted-foreground/80">
        {pending ? "Looking up…" : "No project called this"}
      </p>
      <p className="max-w-md text-xs text-muted-foreground/55">
        {pending
          ? `Waiting on your machines to say whether they know ${slug}.`
          : `Nothing on your connected machines knows about ${slug}. It may have been removed, or it may only exist on a machine that is offline.`}
      </p>
      <Button size="sm" variant="outline" render={<Link to="/projects" />}>
        All projects
      </Button>
    </div>
  );
}
