/**
 * A subagent, as a child row beneath the thread that spawned it.
 *
 * Shaped as a smaller `SidebarThreadRow` rather than its own kind of thing: an
 * agent is something you select and read, exactly like a thread, so it takes
 * the same hover, selection and active affordances. What it drops is
 * everything that implies ownership — no rename, no archive, no menu — because
 * an agent is not yours to manage, only to watch.
 *
 * Both live and disclosed finished `AgentRun` projections use this component.
 * The parent decides which are visible; the thread view keeps a selected
 * native transcript on the normal reading surface — see `ChatView`.
 */
import type { AgentRun } from "@starcode/contracts";
import { PauseIcon } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { HistoryProviderIcon, historyProviderLabel } from "./HistoryProviderIcon";

/**
 * What to call an agent, in the order the data can supply it.
 *
 * The description is the caller's own words and always wins. The agent type
 * is a fallback for an agent that never reported one, and "Agent" is the last
 * resort — a nameless row is still better than a dropped one, because the
 * alternative is the sidebar quietly under-reporting what is running.
 */
export function agentRowLabel(agent: AgentRun): string {
  return agent.description ?? agent.agentType ?? `${historyProviderLabel(agent.provider)} agent`;
}

interface SidebarAgentRowProps {
  readonly agent: AgentRun;
  readonly isActive: boolean;
  readonly onSelect: (agent: AgentRun) => void;
}

export function SidebarAgentRow({ agent, isActive, onSelect }: SidebarAgentRowProps) {
  const label = agentRowLabel(agent);
  const statusLabel = agent.status[0]!.toUpperCase() + agent.status.slice(1);
  const metadata = [
    historyProviderLabel(agent.provider),
    agent.agentType,
    agent.model,
    agent.parentAgentRunId ? `Child of ${agent.parentAgentRunId}` : null,
    statusLabel,
    agent.taskType === "attached_agent"
      ? "Activity timeline available"
      : agent.transcriptState === "pending"
        ? "Transcript discovery in progress"
        : agent.transcriptState === "unavailable"
          ? "Transcript unavailable"
          : "Transcript linked",
  ].filter((value): value is string => value !== null);

  const handleClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onSelect(agent);
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(agent);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      data-testid="sidebar-v2-agent-row"
      data-agent-run-id={agent.agentRunId}
      data-provider={agent.provider}
      data-parent-agent-run-id={agent.parentAgentRunId ?? undefined}
      data-status={agent.status}
      data-transcript-state={agent.transcriptState}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={`${label} — ${metadata.join(" · ")}`}
      aria-label={`${label} — ${metadata.join(", ")}`}
      className={cn(
        // The left inset is the whole hierarchy signal; a connector line would
        // fight the thread rows' own flat treatment.
        "group/agent-row flex h-6 cursor-pointer items-center gap-1.5 rounded-md pr-1.5",
        agent.parentAgentRunId ? "pl-10" : "pl-7",
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
          <HistoryProviderIcon provider={agent.provider} className="size-3" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="hidden shrink-0 truncate text-[10px] text-muted-foreground/50 group-hover/agent-row:inline">
        {[agent.agentType, agent.model].filter(Boolean).join(" · ") || statusLabel}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/50">{statusLabel}</span>
    </div>
  );
}
