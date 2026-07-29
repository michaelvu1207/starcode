import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CopyIcon,
  GitBranchIcon,
  ListChecksIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import {
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { openCommandPalette } from "../commandPaletteBus";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import {
  hasUnseenCompletion,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveAdjacentThreadId,
  resolveSidebarV2Status,
  shouldNavigateAfterProjectRemoval,
  sortLogicalProjectsForSidebar,
} from "./Sidebar.logic";
import { supportsSidebarRangeSelect } from "./Sidebar.connections";
import { partitionSidebarV2Threads } from "./Sidebar.partition";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import { hasThreadTaskProgress } from "./sidebar/ThreadTaskProgress.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter } from "./sidebar/SidebarChrome";
import { SidebarConnectionsView } from "./sidebar/SidebarConnectionsView";
import { SidebarThreadRow } from "./sidebar/SidebarThreadRow";
import { openThreadInFocusedPane } from "./split/openThreadInFocusedPane";
import { openThreadInSplit, useOpenInSplitState } from "./split/openInSplit";
import { SidebarProjectsView } from "./sidebar/SidebarProjectsView";
import { SidebarHeaderCompact } from "./sidebar/SidebarHeaderCompact";
import { useAllProjectsScopeGuard } from "./sidebar/sidebarProjectScope";
import { TooltipPopup, TooltipProvider } from "./ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";

const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

function SidebarV2ThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  environmentLabel,
  driverKind,
  modelInstanceId,
  modelLabel,
  branchMismatch,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  environmentLabel: string | null;
  driverKind: ProviderInstanceEntry["driverKind"] | null;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
}) {
  const planSummary = hasThreadTaskProgress(thread.planSummary) ? thread.planSummary : null;
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={8}
      className="dropdown-glass max-w-80 border-0! text-left whitespace-normal shadow-lg/10 before:hidden dark:shadow-none"
      style={{
        background:
          "color-mix(in srgb, var(--popover) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity), transparent))",
      }}
    >
      <div className="flex max-w-80 flex-col gap-2 p-2">
        <div className="whitespace-nowrap text-sm font-medium text-foreground">{thread.title}</div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          {projectTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={projectCwd ?? ""}
                className="size-4 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">{projectTitle}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{thread.branch}</div>
            </div>
          ) : null}
          {/* The row's progress bar is deliberately wordless, so the counts and
              the step it is currently on live here. */}
          {planSummary ? (
            <div className="flex min-w-0 items-start gap-2">
              <ListChecksIcon
                aria-hidden
                className="mt-0.5 size-4 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 flex-1 wrap-break-word text-foreground/90">
                <span className="tabular-nums">
                  {planSummary.completed}/{planSummary.total}
                </span>{" "}
                tasks
                {planSummary.activeStep ? (
                  <span className="text-muted-foreground"> · {planSummary.activeStep}</span>
                ) : null}
              </div>
            </div>
          ) : null}
          {branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                You're currently checked out on another branch.
              </div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={thread.session?.providerName ?? modelInstanceId}
                iconClassName="size-4 shrink-0"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">{modelLabel}</div>
            </div>
          ) : null}
          {thread.session?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="size-4 shrink-0 stroke-current" />
              <div className="min-w-0 wrap-break-word">{thread.session.lastError}</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}

const SidebarV2Row = memo(function SidebarV2Row(props: {
  thread: SidebarThreadSummary;
  isActive: boolean;
  // Whether *any* thread is open. The split entry on the row menu needs a left
  // pane to open beside, and there is none on /projects or a fresh draft.
  hasRouteThread: boolean;
  jumpLabel: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  projectTitle: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onArchive: (threadRef: ScopedThreadRef) => void;
}) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onArchive,
    onContextMenu,
    onRenameTitleChange,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    renamingTitle,
    thread,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));

  // Same semantics as v1 (never-visited counts as read): flipping the beta
  // flag must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarV2Status(thread);
  // In-flight rows (working, or waiting on approval/input) fade as a whole:
  // there is nothing for the user to do yet, so prominence is reserved for
  // rows that need a human — done (unread) and failed. The status glyph keeps
  // its machine's hue, so waiting rows stay findable. In-flight rows recede
  // the same as read-ready ones (inbox-zero: working threads aren't your
  // problem yet).
  const isInFlight = status === "working" || status === "approval" || status === "input";
  const shouldRecede =
    (status === "ready" || isInFlight) && !isUnread && !props.isActive && !isSelected;

  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const driverKind = providerEntry?.driverKind ?? null;
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const detailsTooltip = (
    <SidebarV2ThreadTooltip
      thread={thread}
      projectTitle={props.projectTitle}
      projectCwd={props.projectCwd}
      environmentLabel={props.environmentLabel}
      driverKind={driverKind}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
    />
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  // The menu's Rename entry and the row's double-click are the same act, so
  // they share one handler rather than one of them reaching around the row.
  const handleStartRename = useCallback(() => {
    onStartRename(threadRef, thread.title);
  }, [onStartRename, thread.title, threadRef]);
  const handleArchiveClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onArchive(threadRef);
    },
    [onArchive, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  // Whether this thread can go to the right of the one you are reading, and if
  // not, why. Resolved here rather than in the row for the same reason as
  // everything else on it: the row stays a function of its props.
  const splitState = useOpenInSplitState({
    threadRef,
    isRouteThread: props.isActive,
    hasRouteThread: props.hasRouteThread,
  });
  const handleOpenInSplit = useCallback(() => openThreadInSplit(threadRef), [threadRef]);
  return (
    <SidebarThreadRow
      thread={thread}
      status={status}
      splitState={splitState}
      onOpenInSplit={handleOpenInSplit}
      flags={{
        isActive: props.isActive,
        isSelected,
        isUnread,
        shouldRecede,
        isRenaming,
      }}
      actions={{
        onClick: handleClick,
        onDoubleClick: handleDoubleClick,
        onKeyDown: handleKeyDown,
        onContextMenu: handleContextMenu,
        onRenameChange: onRenameTitleChange,
        onRenameKeyDown: handleRenameKeyDown,
        onRenameBlur: handleRenameBlur,
        onStartRename: handleStartRename,
        onArchive: handleArchiveClick,
      }}
      timeLabel={threadTimeLabel(thread)}
      driverKind={driverKind}
      jumpLabel={props.jumpLabel}
      renamingTitle={renamingTitle}
      tooltip={detailsTooltip}
    />
  );
});

export default function SidebarV2() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const threadSortOrder = useClientSettings((s) => s.sidebarV2ThreadSortOrder);
  const viewMode = useClientSettings((s) => s.sidebarV2ViewMode);
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { archiveThread, deleteThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const updateSettings = useUpdateClientSettings();
  const { copyToClipboard: copyProjectPath } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const [projectActionsTarget, setProjectActionsTarget] = useState<SidebarProjectSnapshot | null>(
    null,
  );
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  // Post-command navigation validates against the CURRENT route, not the one
  // captured when the command started: if the user navigated elsewhere while
  // it was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      sidebarProjectSortOrder,
    ],
  );
  const projectGroups = useMemo(
    () => sortLogicalProjectsForSidebar(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByInstanceId = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(serverProviders).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    [serverProviders],
  );
  const projectCwdByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          `${project.environmentId}:${project.id}`,
          project.workspaceRoot,
        ]),
      ),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  // Project scope: the filter the list partitions on. The compact header has
  // no picker, so the guard below pins it to all-projects on mount — without
  // it, a scope set anywhere else would hide threads with nothing to unhide
  // them. See sidebar/sidebarProjectScope.ts.
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  useAllProjectsScopeGuard(setProjectScopeKey);
  const scopedProjectGroup = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  );
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
  );
  useEffect(() => {
    if (projectScopeKey !== null && scopedProjectGroup === null) {
      setProjectScopeKey(null);
    }
  }, [projectScopeKey, scopedProjectGroup]);
  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

  const handleRemoveProjectMembers = useCallback(
    async (projectGroup: SidebarProjectSnapshot, members: readonly SidebarProjectGroupMember[]) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === projectGroup.memberProjects.length;
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? projectGroup.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          projectThreads.length > 0
            ? [
                `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                "This permanently clears conversation history for those threads.",
                isWholeGroup
                  ? "This removes only the folder entries, not the files on disk."
                  : "Other entries in this grouped folder are unaffected.",
                "This action cannot be undone.",
              ].join("\n")
            : [
                `Remove project "${targetLabel}"?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                isWholeGroup
                  ? "This removes only the folder entries, not the files on disk."
                  : "Other entries in this grouped folder are unaffected.",
              ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      let shouldNavigate = false;
      for (const project of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        );
        const projectRef = scopeProjectRef(project.environmentId, project.id);
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        const memberRemovalNeedsNavigation = shouldNavigateAfterProjectRemoval({
          routeTarget: routeTargetRef.current,
          projectThreads: memberThreads,
          projectDraftId: projectDraftThread?.draftId ?? null,
        });

        const result = await deleteProject({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            ...(memberThreads.length > 0 ? { force: true } : {}),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Failed to remove "${project.title}"`,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          if (shouldNavigate) {
            void router.navigate({ to: "/" });
          }
          return;
        }

        shouldNavigate ||= memberRemovalNeedsNavigation;
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (shouldNavigate) {
        void router.navigate({ to: "/" });
      }
    },
    [deleteProject, router, threads],
  );

  const renameProjectMember = useCallback(
    async (member: SidebarProjectGroupMember, nextTitle: string) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (title === member.title) return;
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, title },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename folder",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [updateProject],
  );

  const updateProjectGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateSettings],
  );

  // The list works directly off live shells: no archived-snapshot merging, no
  // optimistic holds. Archived threads are the only ones hidden here — archive
  // is what "remove from sidebar" means.
  const orderedThreads = useMemo(
    () =>
      partitionSidebarV2Threads({
        threads,
        scopedProjectKeys,
        threadLastVisitedAtById,
        threadSortOrder,
      }),
    [scopedProjectKeys, threadLastVisitedAtById, threadSortOrder, threads],
  );

  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  // handleNewThread is inherently unstable (depends on the projects list);
  // a ref keeps it out of the callbacks' dependency arrays.
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const [showJumpHints, setShowJumpHints] = useState(false);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      // Fork: with a split open on this route and its second pane focused,
      // this fills that pane instead of navigating. Returns false whenever the
      // split is off — and always on a route that mounts no split, which is
      // read from the ref so this callback does not churn on every navigation.
      if (
        openThreadInFocusedPane(threadRef, { hasRouteThread: routeThreadKeyRef.current !== null })
      )
        return;
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        const trimmed = title.trim();
        setRenamingThreadKey(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === originalTitle) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        if (supportsSidebarRangeSelect(viewMode)) {
          rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        } else {
          toggleThreadSelection(threadKey);
        }
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection, viewMode],
  );

  // Archiving is the row's one-click verb and the menu's last entry — one
  // handler for both, owned here so the row keeps no hooks of its own.
  const attemptArchive = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await archiveThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to archive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [archiveThread],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // One exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (thread deletion
      // elsewhere) and the menu labels must count only what the actions
      // will touch.
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys].filter(
        (threadKey) => threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "mark-unread", label: `Mark unread (${count})` },
            { id: "delete", label: `Delete (${count})`, destructive: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      // Grown as deletions actually land, never seeded with the whole batch:
      // orphaned-worktree detection must only discount threads that are
      // really gone, or the first delete would treat still-alive batch mates
      // as deleted and remove a worktree they still point at.
      const deletedThreadKeys = new Set<string>();
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        deletedThreadKeys.add(threadKey);
      }
      removeFromSelection(threadKeys);
    },
    [clearSelection, confirmThreadDelete, deleteThread, markThreadUnread, removeFromSelection],
  );

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              ...(thread.branch
                ? [
                    {
                      id: "new-thread-on-branch",
                      label: `New thread on ${thread.branch}`,
                    },
                  ]
                : []),
              { id: "rename", label: "Rename thread" },
              { id: "mark-unread", label: "Mark unread" },
              { id: "delete", label: "Delete", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      confirmThreadDelete,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      startThreadRename,
    ],
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    { platform: navigator.platform },
  );
  useEffect(() => {
    setShowJumpHints(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow]);

  const attachListAutoAnimateRef = useCallback((node: HTMLUListElement | null) => {
    if (!node) return;
    autoAnimate(node, { duration: 150, easing: "ease-out" });
  }, []);

  return (
    <>
      <SidebarHeaderCompact
        onNewProject={openAddProjectCommandPalette}
        showProjectActions={projectGroups.length > 0}
      />
      {/* `min-h-full` reaches the scroll viewport, which is the only element in
          this chain with a height to speak of: `SidebarContent` is a
          `ScrollArea`, and its viewport is `h-full` while everything inside it
          is sized by its content. Without this the whole chain is content-height
          and a percentage inside it resolves against nothing. */}
      <SidebarContent className="min-h-full gap-0">
        {/* No `overflow-y-auto` here. It never scrolled — the ScrollArea
            viewport above is the sidebar's scroller — but an `overflow` value
            other than `visible` makes this element the scrollport that any
            `position: sticky` descendant sticks *within*, and this box has no
            scroll range, so it silently cancelled the docked Chats section. */}
        <SidebarGroup className="min-h-0 flex-1 px-2 pb-1 pt-2 [scrollbar-gutter:stable]">
          <TooltipProvider
            key="sidebar-thread-tooltips-150"
            delay={150}
            closeDelay={0}
            timeout={400}
          >
            {/* `flex-1` rather than a percentage minimum, so a section can dock
                itself to the bottom of the scroller with `mt-auto` (the projects
                view's Chats) rather than sitting wherever the content happens to
                end. Flex items keep `min-height: auto`, so a list taller than the
                sidebar still grows past it. No effect on the views that do not
                dock anything. */}
            <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-1 flex-col gap-px">
              {(() => {
                const renderThreadRow = (thread: EnvironmentThreadShell) => {
                  const threadKey = scopedThreadKey(
                    scopeThreadRef(thread.environmentId, thread.id),
                  );
                  return (
                    <SidebarV2Row
                      key={threadKey}
                      thread={thread}
                      isActive={routeThreadKey === threadKey}
                      hasRouteThread={routeThreadKey !== null}
                      jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                      environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                      projectCwd={
                        projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                      }
                      projectTitle={
                        projectDisplayNameByKey.get(
                          `${thread.environmentId}:${thread.projectId}`,
                        ) ?? null
                      }
                      providerEntryByInstanceId={providerEntryByInstanceId}
                      onThreadClick={handleThreadClick}
                      onThreadActivate={navigateToThread}
                      onStartRename={startThreadRename}
                      onRenameTitleChange={setRenamingTitle}
                      onCommitRename={commitThreadRename}
                      onCancelRename={cancelThreadRename}
                      isRenaming={renamingThreadKey === threadKey}
                      renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                      onContextMenu={handleThreadContextMenu}
                      onArchive={attemptArchive}
                    />
                  );
                };
                // Connections view: the same rows, grouped under the machine
                // that runs them instead of merged into one stream.
                if (viewMode === "connections") {
                  return (
                    <SidebarConnectionsView
                      threads={orderedThreads}
                      routeThreadKey={routeThreadKey}
                      renderThreadRow={renderThreadRow}
                    />
                  );
                }
                // Projects view: the same rows again, grouped under the
                // category they were filed into rather than the machine that
                // runs them — so one group mixes machines by design.
                if (viewMode === "projects") {
                  return (
                    <SidebarProjectsView
                      threads={orderedThreads}
                      routeThreadKey={routeThreadKey}
                      renderThreadRow={renderThreadRow}
                    />
                  );
                }
                return orderedThreads.map((thread) => renderThreadRow(thread));
              })()}
            </ul>
          </TooltipProvider>
          {viewMode === "inbox" && orderedThreads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No folders yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroup ? (
                `No threads in ${scopedProjectGroup.displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <Dialog
        open={projectActionsTarget !== null}
        onOpenChange={(open) => {
          if (!open) setProjectActionsTarget(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-balance">Project settings</DialogTitle>
            <DialogDescription>
              {projectActionsTarget && projectActionsTarget.memberProjects.length > 1
                ? `${projectActionsTarget.displayName} has an entry on each machine. Changes apply only to the entry you choose.`
                : `Manage ${projectActionsTarget?.displayName ?? "this folder"} on this machine.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="p-0">
            <div className="divide-y divide-border/60">
              {projectActionsTarget?.memberProjects.map((member) => (
                <section
                  key={member.physicalProjectKey}
                  className="flex min-w-0 flex-col gap-4 px-6 py-5 sm:gap-3 sm:py-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <ProjectFavicon
                      environmentId={member.environmentId}
                      cwd={member.workspaceRoot}
                      className="size-5 shrink-0 sm:size-4"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5 text-base text-muted-foreground sm:text-sm">
                        <ServerIcon className="size-4 shrink-0 stroke-muted-foreground" />
                        <p className="min-w-0 truncate">
                          {member.environmentLabel ?? "Current environment"}
                        </p>
                      </div>
                      <p
                        className="truncate font-mono text-base text-muted-foreground/72 sm:text-sm"
                        title={member.workspaceRoot}
                      >
                        {member.workspaceRoot}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 sm:gap-3 sm:pl-7">
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Project name</span>
                      <Input
                        key={`${member.physicalProjectKey}:${member.title}`}
                        size="sm"
                        aria-label={`Folder name on ${member.environmentLabel ?? "this machine"}`}
                        defaultValue={member.title}
                        onBlur={(event) => {
                          void renameProjectMember(member, event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Grouping rule</span>
                      <Select
                        value={
                          projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                            deriveProjectGroupingOverrideKey(member)
                          ] ?? "inherit"
                        }
                        onValueChange={(value) => {
                          if (
                            value === "inherit" ||
                            value === "repository" ||
                            value === "repository_path" ||
                            value === "separate"
                          ) {
                            updateProjectGroupingPreference(member, value);
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-full"
                          aria-label={`Grouping rule for ${member.environmentLabel ?? "current environment"}`}
                        >
                          <SelectValue>
                            {(() => {
                              const selection =
                                projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                                  deriveProjectGroupingOverrideKey(member)
                                ] ?? "inherit";
                              return selection === "inherit"
                                ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                                : PROJECT_GROUPING_MODE_LABELS[selection];
                            })()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
                          <SelectItem hideIndicator value="inherit">
                            Use global default
                          </SelectItem>
                          <SelectItem hideIndicator value="repository">
                            {PROJECT_GROUPING_MODE_LABELS.repository}
                          </SelectItem>
                          <SelectItem hideIndicator value="repository_path">
                            {PROJECT_GROUPING_MODE_LABELS.repository_path}
                          </SelectItem>
                          <SelectItem hideIndicator value="separate">
                            {PROJECT_GROUPING_MODE_LABELS.separate}
                          </SelectItem>
                        </SelectPopup>
                      </Select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:pl-7">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        copyProjectPath(member.workspaceRoot, { path: member.workspaceRoot })
                      }
                    >
                      <CopyIcon />
                      Copy path
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive-foreground hover:bg-destructive/8 hover:text-destructive-foreground sm:ml-auto"
                      onClick={() => {
                        const projectGroup = projectActionsTarget;
                        if (!projectGroup) return;
                        setProjectActionsTarget(null);
                        void handleRemoveProjectMembers(projectGroup, [member]);
                      }}
                    >
                      <Trash2Icon />
                      Remove
                    </Button>
                  </div>
                </section>
              ))}
            </div>
            {projectActionsTarget && projectActionsTarget.memberProjects.length > 1 ? (
              <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/32 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-base font-medium text-foreground sm:text-sm">
                    Remove this project everywhere
                  </p>
                  <p className="text-base text-pretty text-muted-foreground sm:text-sm">
                    Deletes all grouped entries and their conversation history.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  className="shrink-0"
                  onClick={() => {
                    const projectGroup = projectActionsTarget;
                    setProjectActionsTarget(null);
                    void handleRemoveProjectMembers(projectGroup, projectGroup.memberProjects);
                  }}
                >
                  <Trash2Icon />
                  Remove all entries
                </Button>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button onClick={() => setProjectActionsTarget(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <SidebarChromeFooter />
    </>
  );
}
