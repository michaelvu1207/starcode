/**
 * Fork-owned: the verbs the sidebar's thread context menu acts with.
 *
 * These used to be menu *components*, mounted inside an open `···` popup so
 * that a list of hundreds of rows never paid for hooks it wasn't using. The
 * `···` is gone — every one of these verbs is reached by right-clicking a row
 * now, and that menu is the platform's own (native on desktop, the DOM
 * fallback in a browser), which takes plain items and returns the id you
 * clicked. So there is no component to hang a hook off any more.
 *
 * The laziness that shaped the old file still holds, by different means: this
 * hook is called ONCE, by `SidebarV2`, not once per row. Filing needs the
 * folded project catalog, archiving needs the thread-action commands, forking
 * needs the create command and the router — one subscription for the whole
 * sidebar rather than one per thread.
 *
 * What the hook cannot do is take an environment id at hook time: the sidebar
 * is a single list merged from every connected machine, so which machine a verb
 * talks to is only known when the user clicks. Every verb here therefore reads
 * its environment off the thread it was handed, and the two registry reads that
 * used to be hooks (`useHistoryImports`, `useRefreshHistoryImports`) are their
 * imperative twins.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectCategorySlug, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { newThreadId } from "../../lib/utils";
import { readThreadShell, useServerConfigs } from "../../state/entities";
import {
  refreshProjectCatalogs,
  useFileThreadIntoProject,
  useProjectCatalogView,
} from "../../state/projectCatalog";
import {
  readHistoryImports,
  refreshHistoryImports,
  useForkThreadConversation,
} from "../../state/terminalHistory";
import { resolveThreadProvenance } from "../chat/ThreadHistory.logic";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { planThreadFiling, resolveThreadFilingState } from "./threadProjectFiling";

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

/** Where a thread currently sits, and everywhere the menu could move it to. */
export interface ThreadFilingOptions {
  /** `null` when the thread is unfiled — the "Remove from project" entry hides. */
  readonly currentSlug: ProjectCategorySlug | null;
  readonly targets: ReadonlyArray<{
    readonly slug: ProjectCategorySlug;
    readonly title: string;
  }>;
  /** False on a server predating the catalog: the whole submenu hides. */
  readonly supported: boolean;
}

export interface SidebarThreadVerbs {
  /** Everything "Move to project" needs to render, resolved per thread. */
  readonly filingOptions: (thread: EnvironmentThreadShell) => ThreadFilingOptions;
  readonly moveThreadToProject: (
    thread: EnvironmentThreadShell,
    target: ProjectCategorySlug | null,
  ) => Promise<void>;
  /**
   * Whether this thread's fork can carry the conversation — the answer that
   * picks between the menu's two honest labels. See `canForkConversation`.
   */
  readonly canForkWithConversation: (
    thread: EnvironmentThreadShell,
    driverKind: string | null,
  ) => boolean;
  readonly forkThread: (
    thread: EnvironmentThreadShell,
    carriesConversation: boolean,
  ) => Promise<void>;
  readonly archiveThread: (thread: EnvironmentThreadShell) => Promise<void>;
}

export function useSidebarThreadVerbs(): SidebarThreadVerbs {
  const view = useProjectCatalogView();
  const serverConfigs = useServerConfigs();
  const fileThread = useFileThreadIntoProject();
  const forkThread = useForkThread();
  const { archiveThread: runArchive, unarchiveThread } = useThreadActions();

  // Archived projects own their threads but are not somewhere you file into —
  // the sidebar keeps them behind a disclosure precisely because they are not
  // live work.
  const targets = useMemo(
    () =>
      view.projects
        .filter((project) => !project.archived)
        .map((project) => ({ slug: project.slug, title: project.display.title })),
    [view.projects],
  );

  const filingOptions = useCallback(
    (thread: EnvironmentThreadShell): ThreadFilingOptions => ({
      currentSlug: resolveThreadFilingState({
        projects: view.projects,
        thread: {
          environmentId: thread.environmentId,
          id: thread.id,
          projectId: thread.projectId,
        },
      }).currentSlug,
      targets,
      supported:
        serverConfigs.get(thread.environmentId)?.environment.capabilities.projectCatalog === true,
    }),
    [serverConfigs, targets, view.projects],
  );

  const moveThreadToProject = useCallback(
    async (thread: EnvironmentThreadShell, target: ProjectCategorySlug | null) => {
      const state = resolveThreadFilingState({
        projects: view.projects,
        thread: {
          environmentId: thread.environmentId,
          id: thread.id,
          projectId: thread.projectId,
        },
      });
      const plan = planThreadFiling({ threadId: thread.id, state, target });
      if (plan.length === 0) return;
      try {
        // Sequential, not parallel: an unfile followed by an exclude is an
        // ordered pair, and the registry serialises writes per machine
        // anyway, so overlapping them only loses the ordering.
        for (const request of plan) {
          const outcome = await fileThread({ environmentId: thread.environmentId, request });
          if (outcome.kind !== "ok") {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: target === null ? "Failed to remove from project" : "Failed to move thread",
                description: outcome.message,
              }),
            );
            return;
          }
        }
      } finally {
        refreshProjectCatalogs([thread.environmentId]);
      }
    },
    [fileThread, view.projects],
  );

  const canForkWithConversation = useCallback(
    (thread: EnvironmentThreadShell, driverKind: string | null) => {
      // A best-effort registry read, exactly as lazy as the old menu's
      // `useHistoryImports` was: cold or in flight resolves to "cannot prove
      // it", which understates and never overstates. See `canForkConversation`.
      const imports = readHistoryImports(thread.environmentId);
      return canForkConversation({
        driverKind,
        thread,
        inheritedConversation:
          resolveThreadProvenance({
            imports: imports?.imports ?? null,
            forks: imports?.forks ?? null,
            threadId: thread.id,
          }) !== null,
      });
    },
    [],
  );

  /**
   * Archive, with an Undo.
   *
   * The undo is new, and it is what pays for the verb having moved onto the
   * row as a one-click button: the entry used to sit at the bottom of a menu
   * you had to open, and now it is a target the pointer crosses. Unarchiving
   * otherwise lives in settings, which is too far away to be the escape hatch
   * for a mis-click. Same shape as the snooze toast for the same reason —
   * archiving takes the row off the list, so the toast is the only
   * confirmation there is.
   */
  const archiveThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const result = await runArchive(threadRef);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Archived "${thread.title}"`,
          timeout: 5_000,
          actionProps: {
            children: "Undo",
            onClick: () => {
              void (async () => {
                const undone = await unarchiveThread(threadRef);
                if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                  const error = squashAtomCommandFailure(undone);
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Failed to unarchive thread",
                      description: error instanceof Error ? error.message : "An error occurred.",
                    }),
                  );
                }
              })();
            },
          },
        }),
      );
    },
    [runArchive, unarchiveThread],
  );

  // Memoized, not rebuilt per render: the sidebar hangs its context-menu
  // handler off this object, and a fresh identity every render would hand
  // every row a new callback prop and defeat the row memoization that keeps
  // the list cheap while turns stream.
  return useMemo(
    () => ({
      filingOptions,
      moveThreadToProject,
      canForkWithConversation,
      forkThread,
      archiveThread,
    }),
    [archiveThread, canForkWithConversation, filingOptions, forkThread, moveThreadToProject],
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
function useForkThread(): (
  thread: EnvironmentThreadShell,
  carriesConversation: boolean,
) => Promise<void> {
  const router = useRouter();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const forkConversation = useForkThreadConversation();

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
          refreshHistoryImports(thread.environmentId);
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
