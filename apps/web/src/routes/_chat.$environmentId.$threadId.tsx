import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import ChatView from "../components/ChatView";
import { SplitContainer } from "../components/split/SplitContainer";
import { ArchivedThreadPrompt } from "../components/chat/ArchivedThreadPrompt";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useEnvironmentThreadRefs,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const archivedThreads = useArchivedThreadSnapshots(
    threadRef === null ? [] : [threadRef.environmentId],
  );
  const archivedThread =
    threadRef === null
      ? null
      : (archivedThreads.snapshots
          .find((entry) => entry.environmentId === threadRef.environmentId)
          ?.snapshot.threads.find((thread) => thread.id === threadRef.threadId) ?? null);
  const retainedArchivedThreadRef = useRef(archivedThread);
  if (archivedThread !== null) {
    retainedArchivedThreadRef.current = archivedThread;
  } else if (serverThreadShell?.archivedAt === null) {
    retainedArchivedThreadRef.current = null;
  }
  const retainedArchivedThread = retainedArchivedThreadRef.current;
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (
      renderState === "missing" &&
      retainedArchivedThread === null &&
      !archivedThreads.isLoading &&
      environmentHasAnyThreads
    ) {
      void navigate({ to: "/", replace: true });
    }
  }, [
    archivedThreads.isLoading,
    bootstrapComplete,
    environmentHasAnyThreads,
    navigate,
    renderState,
    retainedArchivedThread,
    threadRef,
  ]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) {
    return null;
  }

  if (retainedArchivedThread !== null && serverThreadShell?.archivedAt !== null) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ArchivedThreadPrompt threadRef={threadRef} title={retainedArchivedThread.title} />
      </SidebarInset>
    );
  }

  if (renderState !== "ready") return null;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <SplitContainer>
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
        />
      </SplitContainer>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
