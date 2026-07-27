/**
 * Fork-owned: the master thread, rendered as a full chat pane.
 *
 * The pane is `ChatView` itself, not a reduced copy of it — the orchestrator is
 * a thread like any other, and an operator talking to it needs the composer,
 * the approvals, the plan surface and everything else that makes a thread
 * usable. `ChatView` takes its identity entirely from props, so embedding it
 * here costs one readiness gate, copied from the thread route.
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ServerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import ChatView from "../ChatView";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import { WorkbenchMasterPicker } from "./WorkbenchMasterPicker";
import type { WorkbenchMasterDesignation } from "./Workbench.master";

function PaneHeader({
  designation,
  alternates,
  picking,
  onTogglePicking,
  onSelectAlternate,
  onClear,
}: {
  designation: WorkbenchMasterDesignation | null;
  alternates: ReadonlyArray<WorkbenchMasterDesignation>;
  picking: boolean;
  onTogglePicking: () => void;
  onSelectAlternate: (designation: WorkbenchMasterDesignation) => void;
  onClear: () => void;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
      <h2 className="text-xs font-medium text-foreground">Master</h2>
      {designation !== null ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/70">
          <ServerIcon aria-hidden className="size-3" />
          <span className="max-w-28 truncate">{designation.label}</span>
        </span>
      ) : null}
      <span className="flex-1" />
      {alternates.map((alternate) => (
        <button
          key={alternate.environmentId}
          type="button"
          onClick={() => onSelectAlternate(alternate)}
          className="cursor-pointer rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground"
        >
          {alternate.label}
        </button>
      ))}
      {designation !== null ? (
        <>
          <button
            type="button"
            onClick={onTogglePicking}
            data-testid="workbench-master-change"
            className={cn(
              "cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] hover:bg-muted/50 hover:text-foreground",
              picking ? "text-foreground" : "text-muted-foreground/70",
            )}
          >
            {picking ? "Cancel" : "Change"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground"
          >
            Clear
          </button>
        </>
      ) : null}
    </header>
  );
}

/**
 * The master thread as a chat, and nothing else.
 *
 * Exported because the project home renders exactly this and no pane header —
 * *"It should just be the chat, like a new thread view"* — so the two surfaces
 * share the readiness gate rather than each keeping their own copy of it.
 */
export function WorkbenchMasterChat({
  threadRef,
  missingFallback,
}: {
  readonly threadRef: ScopedThreadRef;
  /**
   * What to render when the designated id names a thread this machine does not
   * have. The pane says so in a sentence; a surface whose only orchestrator is
   * gone needs a way to name another one, or it is a dead end.
   */
  readonly missingFallback?: ReactNode;
}) {
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
    return <p className="px-3 py-4 text-xs text-muted-foreground/60">Opening the master thread…</p>;
  }
  if (renderState === "missing") {
    // The designated id names a thread this machine does not have: it was
    // deleted, or the draft that reserved the id has not sent its first
    // message yet. Both are recoverable by the operator, and neither is an
    // error worth shouting about.
    if (missingFallback !== undefined) return missingFallback;
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground/60">
        This thread has not started yet. Send its first message, or choose another thread.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
        reserveTitleBarControlInset={false}
      />
    </div>
  );
}

export function WorkbenchMasterPane({
  designation,
  alternates,
  picking,
  onTogglePicking,
  onSelectAlternate,
  onDesignate,
  onCreate,
  onClear,
}: {
  designation: WorkbenchMasterDesignation | null;
  alternates: ReadonlyArray<WorkbenchMasterDesignation>;
  picking: boolean;
  onTogglePicking: () => void;
  onSelectAlternate: (designation: WorkbenchMasterDesignation) => void;
  onDesignate: (environmentId: EnvironmentId, threadId: string) => void;
  onCreate: (projectRef: ScopedProjectRef) => void;
  onClear: () => void;
}) {
  const threadRef =
    designation === null
      ? null
      : scopeThreadRef(
          EnvironmentId.make(designation.environmentId),
          ThreadId.make(designation.threadId),
        );
  const currentThreadKey = threadRef === null ? null : scopedThreadKey(threadRef);

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <PaneHeader
        designation={designation}
        alternates={alternates}
        picking={picking}
        onTogglePicking={onTogglePicking}
        onSelectAlternate={onSelectAlternate}
        onClear={onClear}
      />

      {designation === null || picking ? (
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-6">
          <div className="w-full max-w-lg pb-4">
            <h3 className="text-sm font-medium text-foreground">
              {designation === null ? "No master thread yet" : "Choose a different master"}
            </h3>
            <p className="pt-1 text-xs text-muted-foreground/70">
              The master thread is the one allowed to start work on other machines and interrupt
              threads that are already running. Every other thread can read and message its peers;
              only this one can create and dispatch.
            </p>
          </div>
          <WorkbenchMasterPicker
            currentThreadKey={currentThreadKey}
            onPick={onDesignate}
            onCreate={onCreate}
          />
        </div>
      ) : threadRef !== null ? (
        <WorkbenchMasterChat threadRef={threadRef} />
      ) : null}
    </div>
  );
}
