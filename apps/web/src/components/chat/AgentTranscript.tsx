/**
 * One subagent's transcript, shown in place of the thread's own.
 *
 * A subagent is a thread you can read but not talk to, and the layout says so:
 * same reading column and row vocabulary as the main timeline, no composer.
 * The only control is the way back.
 *
 * Deliberately not virtualized. `MessagesTimeline` earns its LegendList because
 * a thread accumulates thousands of entries over its life; a subagent is a
 * bounded unit of work — tens to low hundreds of rows — and virtualizing it
 * would buy nothing while adding a second scroll-anchoring implementation to
 * keep in step with the first.
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { ArrowLeftIcon, BotIcon, PauseIcon, WrenchIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { ScrollArea } from "../ui/scroll-area";
import type { SubagentTaskState } from "../../session-logic";

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Status word for the header, in the agent's own terms. */
function statusLabel(task: SubagentTaskState): string {
  switch (task.status) {
    case "running":
      return task.lastToolName ? `Running · ${task.lastToolName}` : "Running";
    case "paused":
      return "Paused";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Completed";
  }
}

function AgentRow({
  activity,
  markdownCwd,
}: {
  readonly activity: OrchestrationThreadActivity;
  readonly markdownCwd: string | undefined;
}) {
  const payload = payloadRecord(activity);
  const detail = optionalString(payload?.detail);
  const output = optionalString(payload?.output);

  if (activity.kind === "agent.message") {
    return (
      <div className="px-1 py-1.5 text-sm">
        <ChatMarkdown text={detail ?? activity.summary} cwd={markdownCwd} />
      </div>
    );
  }

  if (activity.kind === "agent.reasoning") {
    // Thinking is set apart rather than styled as prose: it is the agent
    // talking to itself, and reading it as narration misrepresents it.
    return (
      <div className="border-l-2 border-border/60 px-3 py-1.5 text-xs text-muted-foreground/80 italic">
        {detail ?? activity.summary}
      </div>
    );
  }

  const failed = payload?.status === "failed";
  return (
    <div className="flex items-start gap-2 px-1 py-1 text-xs">
      <WrenchIcon
        aria-hidden
        className={cn(
          "mt-0.5 size-3 shrink-0",
          failed ? "text-destructive" : "text-muted-foreground/60",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate", failed ? "text-destructive" : "text-foreground/80")}>
          {detail ?? activity.summary}
        </div>
        {output ? (
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
            {output}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

interface AgentTranscriptProps {
  readonly task: SubagentTaskState;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly threadModel: string | null;
  readonly markdownCwd: string | undefined;
  readonly onBack: () => void;
}

const AgentTranscript = memo(function AgentTranscript({
  task,
  activities,
  threadModel,
  markdownCwd,
  onBack,
}: AgentTranscriptProps) {
  const ordered = useMemo(
    () =>
      [...activities].toSorted((left, right) => {
        // Sequence is the provider's own ordering and the only one that
        // survives same-millisecond bursts; creation time is the fallback for
        // rows that predate it.
        const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
        const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
        if (leftSequence !== rightSequence) return leftSequence - rightSequence;
        return left.createdAt.localeCompare(right.createdAt);
      }),
    [activities],
  );

  const label = task.description || task.subagentType || "Agent";
  const model = task.model ?? threadModel;
  const isLive = task.status === "running" || task.status === "paused";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <button
          type="button"
          onClick={onBack}
          data-testid="agent-transcript-back"
          aria-label="Back to the main thread"
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Thread
        </button>
        <span
          aria-hidden
          className={cn(
            "inline-flex shrink-0 items-center text-muted-foreground",
            task.status === "running" && "animate-status-pulse motion-reduce:animate-none",
          )}
        >
          {task.status === "paused" ? (
            <PauseIcon className="size-3.5" />
          ) : (
            <BotIcon className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
          {statusLabel(task)}
          {model ? ` · ${model}` : ""}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-4 py-4">
          {ordered.length === 0 ? (
            // Distinguishes "nothing yet" from "nothing ever". A live agent
            // that has not spoken is normal; a finished one that produced no
            // rows means its output was never forwarded, and saying so beats
            // an empty pane that looks broken.
            <p className="py-8 text-center text-xs text-muted-foreground/60">
              {isLive
                ? "This agent has not reported anything yet."
                : "This agent finished without producing a transcript."}
            </p>
          ) : (
            ordered.map((activity) => (
              <AgentRow key={activity.id} activity={activity} markdownCwd={markdownCwd} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

export default AgentTranscript;
