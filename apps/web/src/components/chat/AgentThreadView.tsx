import { ArrowLeftIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

interface AgentThreadViewProps {
  readonly children: ReactNode;
  readonly onBack: () => void;
}

/**
 * The only chrome unique to an attached AgentRun.
 *
 * Its conversation body is deliberately supplied by ChatView's ordinary
 * MessagesTimeline. Pi AgentRuns therefore share the exact same transcript
 * layout as their parent instead of maintaining a parallel read-only renderer.
 */
const AgentThreadView = memo(function AgentThreadView({ children, onBack }: AgentThreadViewProps) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="agent-thread-surface">
      <button
        type="button"
        onClick={onBack}
        data-testid="agent-thread-back"
        aria-label="Back to the main thread"
        className="absolute top-1/2 left-2 z-40 inline-flex size-[var(--workspace-titlebar-control-size)] -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground [-webkit-app-region:no-drag]"
      >
        <ArrowLeftIcon aria-hidden className="size-3.5" />
      </button>
      {children}
    </div>
  );
});

export default AgentThreadView;
