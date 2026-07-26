/**
 * Fork-owned: the second pane — a thread picker until it holds a thread, then
 * a full `ChatView`.
 *
 * The embedding recipe is `WorkbenchMasterPane`'s, unchanged: `ChatView`
 * takes its identity entirely from props, so a thread on *any* machine costs
 * one readiness gate copied from the thread route. Two panes on two different
 * machines is the point of this feature, not an edge case.
 *
 * @module SplitSecondaryPane
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useCallback } from "react";

import ChatView from "../ChatView";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkbenchMasterPicker } from "../workbench/WorkbenchMasterPicker";
import { useSplitStore } from "./splitStore";

function SecondaryChat({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete: shell.data?.snapshot._tag === "Some",
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists: false,
  });

  if (renderState === "loading") {
    return <p className="px-4 py-6 text-xs text-muted-foreground/60">Opening this thread…</p>;
  }
  if (renderState === "missing") {
    // The thread was deleted on its machine, or that machine is not connected
    // right now. Both are recoverable by choosing another thread.
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6">
        <p className="max-w-xs text-center text-xs text-muted-foreground/60">
          This thread is not available from here. Its machine may be disconnected.
        </p>
        <ChooseAnotherThreadButton />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
        // The drag band and the traffic-light inset belong to the window, and
        // the window's left edge is the primary pane.
        reserveTitleBarControlInset={false}
      />
    </div>
  );
}

function ChooseAnotherThreadButton() {
  const setSecondary = useSplitStore((state) => state.setSecondary);
  return (
    <Button size="sm" variant="outline" onClick={() => setSecondary(null)}>
      Choose another thread
    </Button>
  );
}

/** The empty state: pick the thread this pane will hold. */
function SplitThreadPicker() {
  const setSecondary = useSplitStore((state) => state.setSecondary);
  const closeSplit = useSplitStore((state) => state.closeSplit);
  // Marks the thread already open in the left pane, so choosing it twice is a
  // decision rather than a surprise.
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  const handlePick = useCallback(
    (environmentId: EnvironmentId, threadId: string) => {
      setSecondary(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)));
    },
    [setSecondary],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <div className="flex items-start gap-2 self-center">
        <div className="w-full max-w-lg pb-4">
          <h3 className="text-sm font-medium text-foreground">Open a second thread</h3>
          <p className="pt-1 text-xs text-muted-foreground/70">
            Any thread on any machine. Both panes stay live, so you can watch two agents work at
            once. Clicking a thread in the sidebar fills whichever pane you last touched.
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                aria-label="Close split view"
                data-testid="split-picker-close"
                className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
                onClick={closeSplit}
              />
            }
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Close split view</TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex justify-center">
        {/* Imported in place: the picker already lists threads across every
            machine with environment label and project title, already has
            search, and its props are generic. Creating a thread is hidden
            here because a new thread is a client-side draft until its first
            message, and this pane renders server threads — a fast-follow, not
            a silent half-feature. */}
        <WorkbenchMasterPicker
          currentThreadKey={routeThreadRef === null ? null : scopedThreadKey(routeThreadRef)}
          onPick={handlePick}
          onCreate={() => {}}
          showCreate={false}
        />
      </div>
    </div>
  );
}

export function SplitSecondaryPane() {
  const secondary = useSplitStore((state) => state.secondary);

  return secondary === null ? (
    <SplitThreadPicker />
  ) : (
    <SecondaryChat key={scopedThreadKey(secondary)} threadRef={secondary} />
  );
}
