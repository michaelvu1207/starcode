/**
 * A side conversation, mounted in the right panel.
 *
 * The embedding recipe is `SplitSecondaryPane`'s, and deliberately so: that
 * component already established that a `ChatView` takes its identity entirely
 * from props, so a second thread costs one readiness gate copied from the
 * thread route. This is the same gate against a different container.
 *
 * What it adds is `suppressRightPanel`. A side thread is itself a thread, and
 * without that flag the view mounted *inside* the right panel can open a right
 * panel of its own — including another side conversation — which is a panel
 * rendering itself at half the width on every level.
 *
 * The readiness states are not decoration. A side thread is created by a round
 * trip (`/side` forks it on the server), so this component is mounted for a
 * frame or two before the thread exists in the shell, and "loading" is the
 * honest answer for that window. "Missing" is the durable case: the parent's
 * machine went away, or the side thread was deleted from under this tab by
 * another client. Rendering an empty transcript for either would look like a
 * conversation that lost its history.
 *
 * @module SidePanelThread
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import ChatView from "../ChatView";

export function SidePanelThread({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useEnvironmentQuery(environmentShell.stateAtom(environmentId));
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
    return (
      <p className="px-4 py-6 text-xs text-muted-foreground/60">Opening this side conversation…</p>
    );
  }

  if (renderState === "missing") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6">
        <p className="max-w-xs text-center text-xs text-muted-foreground/60">
          This side conversation is no longer available. Close the tab to dismiss it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ChatView
        environmentId={environmentId}
        threadId={threadId}
        routeKind="server"
        suppressRightPanel
        // The drag band and the traffic-light inset belong to the window, and
        // this view is nested inside a panel that is already inset from it.
        reserveTitleBarControlInset={false}
      />
    </div>
  );
}
