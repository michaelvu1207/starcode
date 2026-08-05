/**
 * `/projects/$slug` — the project's orchestrator, and its sky.
 *
 * Two panes and a name. Michael's verdict on the first build: *"the Orchestrator
 * tab shouldn't have all this top bar, all this fancy stuff that we're doing to
 * the layout. It should just be the chat, like a new thread view, and on the
 * right side there's the map."*
 *
 * So the left half is `ChatView` with nothing above it — the orchestrator is a
 * thread and it is read like one — and the right half is the same star map the
 * Workbench draws, filtered to this project's membership. What used to sit
 * between them is gone: no connection chips, no feature rollup, no
 * Orchestrator/Edit/Archive/Delete strip, no thread rail. Editing is the
 * sidebar's pencil; archive and delete live inside that dialog. The only chrome
 * left is the mark and the name, which is how you know which project you are
 * looking at.
 */
import { scopeThreadRef, scopedThreadKey } from "@starcode/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ProjectCategorySlug,
  type ScopedProjectRef,
} from "@starcode/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActivities, useThreadShell } from "../../state/entities";
import { useProjectCatalogView, useProjectMembership } from "../../state/projectCatalog";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import type { SkyMaster, SkyProjectScope } from "../workbench/StarMap.model";
import {
  collectMasterCreatedThreadIds,
  resolveWorkbenchMaster,
} from "../workbench/Workbench.master";
import { WorkbenchMasterChat } from "../workbench/WorkbenchMasterPane";
import { WorkbenchMasterPicker } from "../workbench/WorkbenchMasterPicker";
import { WorkbenchStarMap } from "../workbench/WorkbenchStarMap";
import { projectMasterCandidates, projectSectionFor } from "./ProjectCatalog.model";
import { ProjectGlyph } from "./ProjectGlyph";
import { projectAccentHue } from "./ProjectMark.model";
import { useProjectWriter } from "./useProjectWriter";
import "./Projects.css";

export function ProjectHomeView({ slug }: { readonly slug: string }): ReactNode {
  const view = useProjectCatalogView();
  const membership = useProjectMembership(view);
  const writer = useProjectWriter();
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();

  const project = view.projects.find((entry) => entry.slug === slug) ?? null;

  /**
   * This project's orchestrator, resolved through the same function the global
   * Workbench uses.
   *
   * `resolveWorkbenchMaster` takes a candidates array and nothing else, which is
   * exactly why phase 2 built `projectMasterCandidates` to produce one: the
   * fleet passes one candidate per machine's server setting, a project passes
   * one per machine's section, and neither needs the resolver to know which it
   * is. Local-first, and the alternates it also returns are dropped — switching
   * machines was a control on the header strip that no longer exists.
   */
  const designated = useMemo(() => {
    if (project === null) return null;
    return resolveWorkbenchMaster(projectMasterCandidates(project)).designated;
  }, [project]);

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
    },
    [project, writer],
  );

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

  if (project === null) {
    return (
      <MissingProject slug={slug} pending={view.notes.some((note) => note.reason === "pending")} />
    );
  }

  const hue = `${projectAccentHue(project.slug, project.display.accent)}deg`;
  /**
   * What fills the left half before this project has an orchestrator — and
   * again if the one it named is gone.
   *
   * The picker, and the two sentences that say what designating one means.
   * Creating from here goes through the app's own new-thread flow, so the
   * orchestrator starts existing when its first message is sent, the same way
   * every other thread does.
   */
  const start = (
    <div
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-6"
      data-testid="project-master-start"
    >
      <div className="w-full max-w-lg pb-4">
        <h2 className="text-sm font-medium text-foreground">No orchestrator yet</h2>
        <p className="pt-1 text-xs text-muted-foreground/70">
          This project's orchestrator is the thread allowed to start work on other machines and
          interrupt threads that are already running. Start one here, or point this project at a
          thread you already have.
        </p>
      </div>
      <WorkbenchMasterPicker
        currentThreadKey={masterThreadKey}
        onPick={designate}
        onCreate={(projectRef) => void createMaster(projectRef)}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* The whole header. A mark and a name, because a chat pane with a map
          beside it otherwise gives no clue which project it belongs to — and
          everything that used to be up here is either in the sidebar's edit
          dialog or deleted. */}
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2"
        style={{ "--sc-project-hue": hue } as never}
        data-testid="project-home-header"
      >
        <span className="sc-project-mark size-5 shrink-0">
          <ProjectGlyph
            slug={project.slug}
            variant={project.display.glyph}
            icon={project.display.icon}
          />
        </span>
        <h1 className="min-w-0 truncate text-xs font-medium text-foreground">
          {project.display.title}
        </h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-row">
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          data-testid="project-home-chat"
        >
          {masterThreadRef === null ? (
            start
          ) : (
            <WorkbenchMasterChat threadRef={masterThreadRef} missingFallback={start} />
          )}
        </div>

        {/* The map keeps its own footnotes and legend — those sit at the bottom
            of the sky and say what the geography means, which is the opposite
            of the chrome this view just lost. Below `xl` the two panes split
            the height instead of the width, so the map is still visible without
            scrolling. */}
        <div
          className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-border/60 max-xl:flex-1 xl:w-[34rem] xl:flex-none xl:border-l xl:border-t-0"
          data-testid="project-home-sky"
        >
          <WorkbenchStarMap
            masterThreadKey={masterThreadKey}
            master={skyMaster}
            masterCreatedThreadIds={masterCreatedThreadIds}
            scope={scope}
            emptyLabel="Nothing is filed here yet. Bind a folder to this project and its threads appear, or file one from the thread itself."
          />
        </div>
      </div>
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
    </div>
  );
}
