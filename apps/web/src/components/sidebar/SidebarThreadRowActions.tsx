/**
 * Fork-owned: the row menu's verbs that act on the thread itself.
 *
 * Split out of `SidebarThreadRow` rather than added to it, for one structural
 * reason: these need hooks, and the row is rendered once per thread in a list
 * that can run to hundreds. Filing needs the folded project catalog, archiving
 * needs the thread-action commands, forking needs the create command and the
 * router — subscribing every row to all of that so that one row's menu can open
 * would make scrolling the sidebar pay for a menu nobody opened.
 *
 * So the components here are rendered *inside the open popup* and nowhere else.
 * One row's menu is open at a time, so these hooks run once, on demand, and the
 * row above them stays the pure function of its props that it was.
 *
 * Two exports rather than one because the menu is not one block: renaming,
 * filing and forking sit above the lifecycle entries, and archiving sits below
 * everything, which is where the entry that takes a thread off the list belongs.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectCategorySlug, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CheckIcon,
  FolderInputIcon,
  GitBranchPlusIcon,
  PencilIcon,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import { useThreadActions } from "../../hooks/useThreadActions";
import { newThreadId } from "../../lib/utils";
import { readThreadShell, useServerConfigs } from "../../state/entities";
import {
  refreshProjectCatalogs,
  useFileThreadIntoProject,
  useProjectCatalogView,
} from "../../state/projectCatalog";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectGlyph } from "../projects/ProjectGlyph";
import { projectAccentHue } from "../projects/ProjectsIndex.model";
import { MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { planThreadFiling, resolveThreadFilingState } from "./threadProjectFiling";
import "../projects/Projects.css";

/**
 * How long to let the websocket deliver a thread the server has already
 * created before navigating to it anyway. Same contract as the import dialog's:
 * the alternative to waiting is landing on a route that resolves to nothing.
 */
const FORKED_THREAD_ARRIVAL_TIMEOUT_MS = 8_000;
const FORKED_THREAD_POLL_INTERVAL_MS = 100;

/** Titles are display, but an unbounded one is a row that never truncates. */
const FORK_TITLE_MAX_LENGTH = 120;
const FORK_TITLE_SUFFIX = " (fork)";

export function forkThreadTitle(title: string): string {
  const trimmed = title.trim();
  const room = FORK_TITLE_MAX_LENGTH - FORK_TITLE_SUFFIX.length;
  const base = trimmed.length > room ? `${trimmed.slice(0, room - 1)}…` : trimmed;
  return `${base}${FORK_TITLE_SUFFIX}`;
}

/**
 * Whether this machine's server understands the project catalog at all. A
 * pre-catalog server has nowhere to file a thread, and an entry that always
 * failed would be worse than no entry.
 */
function useProjectCatalogSupported(environmentId: EnvironmentId): boolean {
  const serverConfigs = useServerConfigs();
  return serverConfigs.get(environmentId)?.environment.capabilities.projectCatalog === true;
}

/**
 * Rename, file, and fork — the three things you do to a thread that leave it on
 * the list.
 */
export function ThreadRowFilingActions({
  thread,
  onRename,
}: {
  readonly thread: EnvironmentThreadShell;
  /** Puts the row into its inline rename input; owned by the sidebar. */
  readonly onRename: () => void;
}): ReactNode {
  const catalogSupported = useProjectCatalogSupported(thread.environmentId);
  const forkThread = useForkThread();

  return (
    <>
      <MenuItem
        closeOnClick
        data-testid="sidebar-v2-row-rename"
        // Every entry in this file stops propagation for the reason the split
        // entry documents: the popup is portalled to the body, but a React
        // portal's events bubble up the *component* tree, so an unguarded click
        // reaches the row and navigates.
        onClick={(event) => {
          event.stopPropagation();
          onRename();
        }}
        className="sm:text-xs"
      >
        <PencilIcon aria-hidden className="size-3.5" />
        Rename
      </MenuItem>
      {catalogSupported ? <ThreadRowProjectSubmenu thread={thread} /> : null}
      <MenuItem
        closeOnClick
        data-testid="sidebar-v2-row-fork"
        onClick={(event) => {
          event.stopPropagation();
          void forkThread(thread);
        }}
        className="sm:text-xs"
      >
        <GitBranchPlusIcon aria-hidden className="size-3.5" />
        Fork thread
      </MenuItem>
    </>
  );
}

/**
 * "Move to project", as a submenu.
 *
 * A submenu rather than a dialog because the answer is a short list you already
 * know the shape of, and a dialog for a one-click decision is a dialog you
 * dismiss. The current project is listed and ticked rather than hidden — a list
 * that silently omits where you are is a list you check twice.
 *
 * "Remove from project" leads, above the projects, because it is the only entry
 * that is not a project name, and because a thread filed by mistake is the case
 * you reach for this menu in a hurry.
 */
function ThreadRowProjectSubmenu({
  thread,
}: {
  readonly thread: EnvironmentThreadShell;
}): ReactNode {
  const view = useProjectCatalogView();
  const fileThread = useFileThreadIntoProject();
  const [busy, setBusy] = useState(false);

  const membershipThread = useMemo(
    () => ({ environmentId: thread.environmentId, id: thread.id, projectId: thread.projectId }),
    [thread.environmentId, thread.id, thread.projectId],
  );
  const state = useMemo(
    () => resolveThreadFilingState({ projects: view.projects, thread: membershipThread }),
    [membershipThread, view.projects],
  );
  // Archived projects own their threads but are not somewhere you file into —
  // the sidebar keeps them behind a disclosure precisely because they are not
  // live work.
  const targets = useMemo(
    () => view.projects.filter((project) => !project.archived),
    [view.projects],
  );

  const move = useCallback(
    (target: ProjectCategorySlug | null) => {
      const plan = planThreadFiling({ threadId: thread.id, state, target });
      if (plan.length === 0 || busy) return;
      setBusy(true);
      void (async () => {
        try {
          // Sequential, not parallel: an unfile followed by an exclude is an
          // ordered pair, and the registry serialises writes per machine
          // anyway, so overlapping them only loses the ordering.
          for (const request of plan) {
            const outcome = await fileThread({
              environmentId: thread.environmentId,
              request,
            });
            if (outcome.kind !== "ok") {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title:
                    target === null ? "Failed to remove from project" : "Failed to move thread",
                  description: outcome.message,
                }),
              );
              return;
            }
          }
        } finally {
          refreshProjectCatalogs([thread.environmentId]);
          setBusy(false);
        }
      })();
    },
    [busy, fileThread, state, thread.environmentId, thread.id],
  );

  // Nothing to file into and nothing to unfile from: the trigger would open a
  // menu with one dead line in it.
  if (targets.length === 0 && state.currentSlug === null) return null;

  return (
    <MenuSub>
      <MenuSubTrigger data-testid="sidebar-v2-row-move-to-project" className="sm:text-xs">
        <FolderInputIcon aria-hidden className="size-3.5" />
        Move to project
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-44">
        {state.currentSlug === null ? null : (
          <>
            <MenuItem
              closeOnClick
              data-testid="sidebar-v2-row-move-to-chats"
              onClick={(event) => {
                event.stopPropagation();
                move(null);
              }}
              className="sm:text-xs"
            >
              Remove from project
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {targets.map((project) => {
          const isCurrent = project.slug === state.currentSlug;
          return (
            <MenuItem
              key={project.slug}
              closeOnClick
              disabled={isCurrent}
              data-testid="sidebar-v2-row-move-target"
              data-slug={project.slug}
              data-current={isCurrent ? "true" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (!isCurrent) move(project.slug);
              }}
              className="sm:text-xs"
            >
              <span
                className={cn("sc-project-mark size-3.5 shrink-0")}
                style={
                  {
                    "--sc-project-hue": `${projectAccentHue(
                      project.slug,
                      project.display.accent,
                    )}deg`,
                  } as never
                }
              >
                <ProjectGlyph slug={project.slug} variant={project.display.glyph} />
              </span>
              <span className="min-w-0 flex-1 truncate">{project.display.title}</span>
              {isCurrent ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
            </MenuItem>
          );
        })}
      </MenuSubPopup>
    </MenuSub>
  );
}

/**
 * Archive, and only archive.
 *
 * Last in the menu and alone below the final separator, because it is the one
 * entry that takes the thread off the list. There is no "Unarchive" twin here:
 * the sidebar's partition excludes archived threads by construction, so this
 * menu is never rendered on one. Unarchiving lives where archived threads are
 * actually listed, in settings.
 */
export function ThreadRowArchiveAction({
  thread,
}: {
  readonly thread: EnvironmentThreadShell;
}): ReactNode {
  const { archiveThread } = useThreadActions();

  const archive = useCallback(
    (event: ReactMouseEvent) => {
      event.stopPropagation();
      void (async () => {
        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
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
    [archiveThread, thread.environmentId, thread.id],
  );

  return (
    <MenuItem
      closeOnClick
      data-testid="sidebar-v2-row-archive"
      onClick={archive}
      className="sm:text-xs"
    >
      <ArchiveIcon aria-hidden className="size-3.5" />
      Archive
    </MenuItem>
  );
}

async function waitForForkedThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<void> {
  const ref = scopeThreadRef(environmentId, threadId);
  const deadline = Date.now() + FORKED_THREAD_ARRIVAL_TIMEOUT_MS;
  while (readThreadShell(ref) === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, FORKED_THREAD_POLL_INTERVAL_MS));
  }
}

/**
 * Forking, and what it honestly is here.
 *
 * The new thread inherits everything about *where and how* the source runs —
 * machine, project, branch, worktree, provider instance, model, permission and
 * interaction mode — and starts its own conversation. It does not inherit the
 * agent's context, and it deliberately does not try to: the only client-visible
 * handle on a running conversation would be the provider's session, and two
 * threads pointed at one session append to one transcript and corrupt both. The
 * toast says which half you got, at the moment you get it, rather than leaving
 * the word "fork" to imply the other half.
 *
 * (Carrying the conversation is possible, but it is a server feature — see the
 * fork report. Nothing here is in its way: it would put a resume cursor on the
 * thread this already creates.)
 */
function useForkThread(): (thread: EnvironmentThreadShell) => Promise<void> {
  const router = useRouter();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  return useCallback(
    async (thread: EnvironmentThreadShell) => {
      const threadId = newThreadId();
      const title = forkThreadTitle(thread.title);
      const result = await createThread({
        environmentId: thread.environmentId,
        input: {
          threadId,
          projectId: thread.projectId,
          title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to fork thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      await waitForForkedThreadShell(thread.environmentId, threadId);
      toastManager.add({
        type: "success",
        title: `Forked "${thread.title}"`,
        description: "Same folder, branch and model. The conversation starts fresh.",
        timeout: 6_000,
      });
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, threadId)),
      });
    },
    [createThread, router],
  );
}
