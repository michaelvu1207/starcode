import type { AgentRun, EnvironmentId } from "@starcode/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { memo } from "react";

import { ScrollArea } from "../ui/scroll-area";
import { HistoryThreadTimeline } from "./ThreadHistorySection";

interface AgentThreadViewProps {
  readonly agentRun: AgentRun;
  readonly markdownCwd: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly onBack: () => void;
}

/**
 * A read-only agent opened in the ordinary thread reading surface.
 *
 * This deliberately owns no special transcript frame, disclosure bar, header,
 * or nested scroller. The only agent-specific chrome is the floating way back
 * to the parent, which does not reserve space above the conversation.
 */
const AgentThreadView = memo(function AgentThreadView({
  agentRun,
  markdownCwd,
  environmentId,
  onBack,
}: AgentThreadViewProps) {
  const linkedHistorySessionId =
    agentRun.transcriptState === "linked" ? agentRun.historySessionId : null;

  return (
    <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        onClick={onBack}
        data-testid="agent-thread-back"
        aria-label="Back to the main thread"
        className="absolute top-1/2 left-2 z-40 inline-flex size-[var(--workspace-titlebar-control-size)] -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground [-webkit-app-region:no-drag]"
      >
        <ArrowLeftIcon aria-hidden className="size-3.5" />
      </button>
      <ScrollArea className="min-h-0 flex-1" scrollbarGutter>
        <div className="px-3 sm:px-5">
          <div
            className="mx-auto flex w-full min-w-0 max-w-3xl flex-col overflow-x-clip py-3 sm:py-4"
            data-testid="agent-thread-reading-surface"
          >
            {linkedHistorySessionId ? (
              <HistoryThreadTimeline
                environmentId={environmentId}
                sessionId={linkedHistorySessionId}
                model={{
                  provider: agentRun.provider,
                  sessionId: linkedHistorySessionId,
                  before: null,
                  summary: "native agent history",
                }}
                cwd={markdownCwd ?? null}
              />
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground/60">
                {agentRun.transcriptState === "pending"
                  ? "Transcript discovery is in progress."
                  : "Transcript unavailable. The native history could not be recovered safely."}
              </p>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
});

export default AgentThreadView;
