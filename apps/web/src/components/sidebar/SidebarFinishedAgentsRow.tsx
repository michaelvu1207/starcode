import { BotIcon, ChevronRightIcon } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";

interface SidebarFinishedAgentsRowProps {
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
}

/**
 * A single disclosure keeps completed agent history discoverable without
 * permanently turning the selected thread into a large tree.
 */
export function SidebarFinishedAgentsRow({ isExpanded, onToggle }: SidebarFinishedAgentsRowProps) {
  const handleClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    onToggle();
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      data-testid="sidebar-v2-finished-agents-row"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "group/finished-agent-row flex h-6 cursor-pointer items-center gap-1.5 rounded-md pr-1.5 pl-7",
        "text-xs text-muted-foreground/70 transition-colors",
        "hover:bg-sidebar-row-hover hover:text-foreground",
      )}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", isExpanded && "rotate-90")}
      />
      <BotIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">View finished subagents</span>
    </div>
  );
}
