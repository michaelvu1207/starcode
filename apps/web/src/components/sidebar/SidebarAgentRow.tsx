/**
 * A subagent, as a child row beneath the thread that spawned it.
 *
 * Shaped as a smaller `SidebarThreadRow` rather than its own kind of thing: an
 * agent is something you select and read, exactly like a thread, so it takes
 * the same hover, selection and active affordances. What it drops is
 * everything that implies ownership — no rename, no archive, no menu — because
 * an agent is not yours to manage, only to watch.
 *
 * Only live agents ever reach this component; the parent decides that. A row
 * that vanished mid-read would be jarring, so the thread view keeps showing a
 * selected agent's transcript after its row disappears — see `ChatView`.
 */
import type { OrchestrationThreadSubagent } from "@starcode/contracts";
import { BotIcon, PauseIcon } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";

/**
 * Token counts are the number most likely to be *compared* between rows, so
 * they get a fixed shape rather than being printed in full: 81,724 and 4,200
 * are hard to rank at a glance; 81.7k and 4.2k are not.
 */
function formatTokens(totalTokens: number | null): string | null {
  if (totalTokens === null) return null;
  if (totalTokens < 1000) return `${totalTokens}`;
  if (totalTokens < 1_000_000) return `${(totalTokens / 1000).toFixed(1)}k`;
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}

/**
 * What to call an agent, in the order the data can supply it.
 *
 * The description is the caller's own words and always wins. The subagent type
 * is a fallback for an agent that never reported one, and "Agent" is the last
 * resort — a nameless row is still better than a dropped one, because the
 * alternative is the sidebar quietly under-reporting what is running.
 */
export function agentRowLabel(agent: OrchestrationThreadSubagent): string {
  return agent.description ?? agent.subagentType ?? "Agent";
}

interface SidebarAgentRowProps {
  readonly agent: OrchestrationThreadSubagent;
  readonly isActive: boolean;
  readonly onSelect: (taskId: string) => void;
}

export function SidebarAgentRow({ agent, isActive, onSelect }: SidebarAgentRowProps) {
  const label = agentRowLabel(agent);
  const tokens = formatTokens(agent.totalTokens);
  // What it is doing this second. This is the difference between "three agents
  // are running" and knowing whether any of them is stuck.
  const subtitle = agent.status === "paused" ? "Paused" : agent.lastToolName;

  const handleClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onSelect(agent.taskId);
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(agent.taskId);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      data-testid="sidebar-v2-agent-row"
      data-task-id={agent.taskId}
      data-status={agent.status}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={subtitle ? `${label} — ${subtitle}` : label}
      className={cn(
        // The left inset is the whole hierarchy signal; a connector line would
        // fight the thread rows' own flat treatment.
        "group/agent-row flex h-6 cursor-pointer items-center gap-1.5 rounded-md pr-1.5 pl-7",
        "text-xs transition-colors",
        isActive
          ? "bg-sidebar-row-active text-foreground"
          : "text-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center",
          agent.status === "running" && "animate-status-pulse motion-reduce:animate-none",
        )}
      >
        {agent.status === "paused" ? (
          <PauseIcon className="size-3" />
        ) : (
          <BotIcon className="size-3" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {subtitle ? (
        <span className="hidden shrink-0 truncate text-[10px] text-muted-foreground/50 group-hover/agent-row:inline">
          {subtitle}
        </span>
      ) : null}
      {tokens ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">{tokens}</span>
      ) : null}
    </div>
  );
}
