/**
 * The subagent task list.
 *
 * Deliberately shaped like `PlanSidebar` — same header badge, same
 * `ScrollArea`, same three-way `mode` — because the two answer neighbouring
 * questions from the same slot, and a panel that looked like its own product
 * would read as one.
 *
 * What it adds over a plan's step list is that every row is *live*: a subagent
 * has a model, a running token count, and something it is doing this second.
 * The numbers are right-aligned and tabular so a column of them can be scanned
 * rather than read, and the row's subtitle is the tool it is in right now,
 * which is the difference between "three agents are running" and knowing
 * whether any of them is stuck.
 */
import { memo } from "react";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { CheckIcon, CircleSlashIcon, LoaderIcon, PauseIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { SubagentTaskState } from "../session-logic";

function taskStatusIcon(status: SubagentTaskState["status"]): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlertIcon className="size-3" />
      </span>
    );
  }
  if (status === "stopped") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/70">
        <CircleSlashIcon className="size-3" />
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning-foreground">
        <PauseIcon className="size-3" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
      <LoaderIcon className="size-3 animate-spin" />
    </span>
  );
}

/**
 * Token counts are the number most likely to be *compared* between rows, so
 * they are abbreviated to a fixed shape rather than printed in full — 81,724
 * and 4,200 are hard to rank at a glance; 81.7k and 4.2k are not.
 */
function formatTokens(totalTokens: number | null): string | null {
  if (totalTokens === null) return null;
  if (totalTokens < 1000) return `${totalTokens}`;
  if (totalTokens < 1_000_000) return `${(totalTokens / 1000).toFixed(1)}k`;
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) return null;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface SubagentsSidebarProps {
  tasks: ReadonlyArray<SubagentTaskState>;
  /** The thread's own model, shown for subagents that inherited it. */
  threadModel?: string | null;
  label?: string;
  mode?: "sheet" | "sidebar" | "embedded";
}

const SubagentsSidebar = memo(function SubagentsSidebar({
  tasks,
  threadModel = null,
  label = "Agents",
  mode = "sidebar",
}: SubagentsSidebarProps) {
  const runningCount = tasks.filter(
    (task) => task.status === "running" || task.status === "paused",
  ).length;
  const doneCount = tasks.length - runningCount;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            {label}
          </Badge>
          {tasks.length > 0 ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {runningCount > 0 ? `${runningCount} running` : null}
              {runningCount > 0 && doneCount > 0 ? " / " : null}
              {doneCount > 0 ? `${doneCount} done` : null}
            </span>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-3">
          {tasks.map((task) => {
            const tokens = formatTokens(task.totalTokens);
            const duration = formatDuration(task.durationMs);
            const isLive = task.status === "running" || task.status === "paused";
            return (
              <div
                key={task.taskId}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                  task.status === "running" && "bg-blue-500/5",
                  task.status === "completed" && "bg-emerald-500/5",
                  task.status === "failed" && "bg-destructive/5",
                )}
              >
                <span className="mt-0.5">{taskStatusIcon(task.status)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p
                      className={cn(
                        "truncate text-[13px] leading-snug",
                        isLive ? "text-foreground/90" : "text-muted-foreground/70",
                      )}
                    >
                      {task.description || task.subagentType || task.taskId}
                    </p>
                    {tokens ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
                        {tokens}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2">
                    <p className="truncate text-[11px] text-muted-foreground/50">
                      {[task.subagentType, task.model ?? threadModel].filter(Boolean).join(" · ")}
                    </p>
                    {duration ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground/40 tabular-nums">
                        {duration}
                      </span>
                    ) : null}
                  </div>
                  {/* Only while live: after it finishes, the last tool it happened
                      to touch says nothing about the outcome. */}
                  {isLive && task.lastToolName ? (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground/40">
                      {task.lastToolName}
                    </p>
                  ) : null}
                  {task.error ? (
                    <p className="mt-0.5 truncate text-[11px] text-destructive/80">{task.error}</p>
                  ) : null}
                </div>
              </div>
            );
          })}

          {/* Empty state */}
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No subagents yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Tasks appear here while subagents are running.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default SubagentsSidebar;
export type { SubagentsSidebarProps };
