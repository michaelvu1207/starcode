/**
 * Fork-owned: the row menu's verbs that act on the thread itself.
 *
 * Split out of `SidebarThreadRow` rather than added to it, for one structural
 * reason: these need hooks, and the row is rendered once per thread in a list
 * that can run to hundreds. Filing needs the folded project catalog, forking
 * needs the create command and the router — subscribing every row to all of
 * that so that one row's menu can open would make scrolling the sidebar pay
 * for a menu nobody opened.
 *
 * So the components here are rendered *inside the open popup* and nowhere else.
 * One row's menu is open at a time, so these hooks run once, on demand, and the
 * row above them stays the pure function of its props that it was.
 *
 * Two exports rather than one because the menu is not one block: renaming,
 * filing and forking sit at the top, and archiving sits alone at the bottom,
 * which is where the entry that takes a thread off the list belongs.
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

import { newThreadId } from "../../lib/utils";
import { readThreadShell, useServerConfigs } from "../../state/entities";
import {
  refreshProjectCatalogs,
  useFileThreadIntoProject,
  useProjectCatalogView,
} from "../../state/projectCatalog";
import {
  useForkThreadConversation,
  useHistoryImports,
  useRefreshHistoryImports,
} from "../../state/terminalHistory";
import { resolveThreadProvenance } from "../chat/ThreadHistory.logic";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectGlyph } from "../projects/ProjectGlyph";
import { projectAccentHue } from "../projects/ProjectMark.model";
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

/**
 * The `ProviderDriverKind` the Claude driver registers — `claudeAgent`, not
 * `claude`. The server gates on the same string, and the two spellings living
 * in different vocabularies is the trap: `claude` is what `HistoryProvider`
 * calls the same provider, and using it here would silently label every Claude
 * thread "setup only".
 */
const CLAUDE_DRIVER_KIND = "claudeAgent";

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
  driverKind,
  onRename,
}: {
  readonly thread: EnvironmentThreadShell;
  /** Which agent drives the thread. Only some can fork a session — see below. */
  readonly driverKind: string | null;
  /** Puts the row into its inline rename input; owned by the sidebar. */
  readonly onRename: () => void;
}): ReactNode {
  const catalogSupported = useProjectCatalogSupported(thread.environmentId);
  const forkThread = useForkThread(thread.environmentId);
  // Shared, cached, and already read by the thread view and the picker, so
  // this costs the row nothing. It is here because a thread can carry a
  // conversation it has never spoken a word of — see `canForkConversation`.
  const provenance = useHistoryImports(thread.environmentId);
  const carriesConversation = canForkConversation({
    driverKind,
    thread,
    inheritedConversation:
      resolveThreadProvenance({
        imports: provenance.data?.imports ?? null,
        forks: provenance.data?.forks ?? null,
        threadId: thread.id,
      }) !== null,
  });

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
      {/* One entry, two honest labels. Which one you get is a property of the
          thread — its agent, and whether it has said anything yet — and saying
          so on the entry is what stops the click being a surprise. Deliberately
          NOT disabled in the setup-only case: a fork that carries the branch,
          worktree and model is still worth having, and taking it away from
          every Codex thread to make a point would be a worse trade. */}
      <MenuItem
        closeOnClick
        data-testid="sidebar-v2-row-fork"
        data-carries-conversation={carriesConversation ? "true" : "false"}
        onClick={(event) => {
          event.stopPropagation();
          void forkThread(thread, carriesConversation);
        }}
        className="sm:text-xs"
      >
        <GitBranchPlusIcon aria-hidden className="size-3.5" />
        <span className="flex-1">
          {carriesConversation ? "Fork with conversation" : "Fork thread"}
        </span>
        {carriesConversation ? null : (
          <span className="text-[10px] text-muted-foreground/60">setup only</span>
        )}
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
                <ProjectGlyph
                  slug={project.slug}
                  variant={project.display.glyph}
                  icon={project.display.icon}
                />
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
 * the sidebar excludes archived threads by construction, so this menu is never
 * rendered on one. Unarchiving lives where archived threads are actually
 * listed, in settings.
 *
 * Presentational, unlike its neighbours above: the row now carries an archive
 * button of its own, and the two must be one act rather than two
 * implementations that could drift. The handler is the row's, passed down.
 */
export function ThreadRowArchiveAction({
  onArchive,
}: {
  readonly onArchive: (event: ReactMouseEvent) => void;
}): ReactNode {
  return (
    <MenuItem
      closeOnClick
      data-testid="sidebar-v2-row-archive-menu"
      // Stopped here as well as in the handler: every click in this file has
      // to stop, and an entry whose guard lives in somebody else's callback is
      // one refactor away from navigating the row it was meant to file away.
      onClick={(event) => {
        event.stopPropagation();
        onArchive(event);
      }}
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
 * Whether this thread's fork can carry the conversation, guessed from what the
 * row already knows.
 *
 * The agent has to be one that can fork a *session* — only Claude can; Codex's
 * app-server has `thread/resume` and no fork, and resuming appends to the same
 * rollout, so a Codex "fork" would be two threads writing one transcript.
 *
 * Then the thread has to have a conversation to carry, which is true in two
 * ways rather than one. Usually it means the thread has started a session. But
 * an imported or forked thread carries hundreds of messages before it has said
 * anything at all — the model's context came back with the resumed session —
 * and treating that as "nothing to carry" would fork it into the exact amnesia
 * the provenance line exists to warn about, silently, on a menu entry that
 * promised a fork.
 *
 * A guess, deliberately: the authoritative answer lives in the source thread's
 * resume cursor, which is server-side and would cost a round trip per row to
 * render a label. So this decides what the menu *says*, the server decides what
 * actually happens, and the toast reports the server's answer. When they
 * disagree the fork still lands — as a setup fork — and says so.
 */
export function canForkConversation(input: {
  readonly driverKind: string | null;
  readonly thread: Pick<EnvironmentThreadShell, "session">;
  /** Whether this thread resumed somebody else's conversation to begin with. */
  readonly inheritedConversation?: boolean;
}): boolean {
  if (input.driverKind !== CLAUDE_DRIVER_KIND) return false;
  return input.thread.session !== null || input.inheritedConversation === true;
}

/**
 * Forking, both halves of it.
 *
 * The **conversation fork** is a server call, because naming the session behind
 * a thread is something only the server can do — the client is never told a
 * thread's provider session id. The server binds the new thread to the source's
 * session with a marker that makes the provider fork on the first turn, so the
 * source's transcript is read and never written.
 *
 * The **setup fork** is what happens otherwise, and it is a plain
 * `thread.create`: same machine, project, branch, worktree, model, permission
 * and interaction mode, fresh conversation.
 *
 * Every path that cannot carry the conversation falls back to the setup fork
 * rather than failing. A refusal is information ("this agent cannot fork a
 * session", "this thread has not spoken yet"), not a dead end, and the user
 * still wanted a sibling thread — so they get one, and the toast says which
 * kind they got and why. The one thing that must never happen is a fork that
 * *claims* to carry the conversation and does not.
 */
function useForkThread(
  /** The machine whose provenance registry a successful fork invalidates. */
  environmentId: EnvironmentId,
): (thread: EnvironmentThreadShell, carriesConversation: boolean) => Promise<void> {
  const router = useRouter();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const forkConversation = useForkThreadConversation();
  const refreshProvenance = useRefreshHistoryImports(environmentId);

  return useCallback(
    async (thread: EnvironmentThreadShell, carriesConversation: boolean) => {
      const goTo = async (threadId: ThreadId) => {
        await waitForForkedThreadShell(thread.environmentId, threadId);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, threadId)),
        });
      };

      if (carriesConversation) {
        const attempt = await forkConversation({
          environmentId: thread.environmentId,
          threadId: thread.id,
          request: {},
        });
        if (attempt.kind === "forked") {
          // The server just wrote a provenance row, and this registry is
          // cached per machine with no refresh of its own. Without re-reading
          // it, the fork we are about to navigate to opens looking like an
          // ordinary empty thread — with the conversation it inherited hidden
          // behind a line that has not arrived yet.
          refreshProvenance();
          await goTo(attempt.result.threadId);
          toastManager.add({
            type: "success",
            title: `Forked "${thread.title}"`,
            description: "The agent keeps the conversation. The original is untouched.",
            timeout: 6_000,
          });
          return;
        }
        // Fall through to the setup fork, carrying the reason so the toast can
        // explain why this one starts fresh.
        const why = attempt.kind === "refused" ? attempt.detail : attempt.message;
        await createSetupFork(thread, why);
        return;
      }
      await createSetupFork(thread, null);

      async function createSetupFork(
        source: EnvironmentThreadShell,
        why: string | null,
      ): Promise<void> {
        const threadId = newThreadId();
        const result = await createThread({
          environmentId: source.environmentId,
          input: {
            threadId,
            projectId: source.projectId,
            title: forkThreadTitle(source.title),
            modelSelection: source.modelSelection,
            runtimeMode: source.runtimeMode,
            interactionMode: source.interactionMode,
            branch: source.branch,
            worktreePath: source.worktreePath,
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
        await goTo(threadId);
        toastManager.add({
          type: "success",
          title: `Forked "${source.title}"`,
          description:
            why === null
              ? "Same folder, branch and model. The conversation starts fresh."
              : `Same folder, branch and model, but the conversation starts fresh: ${why}`,
          timeout: 6_000,
        });
      }
    },
    [createThread, forkConversation, router],
  );
}
