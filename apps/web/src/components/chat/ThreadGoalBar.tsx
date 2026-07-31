import type { ThreadGoal } from "@starcode/contracts";
import {
  CheckIcon,
  PencilIcon,
  PauseIcon,
  PlayIcon,
  TargetIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface ThreadGoalBarProps {
  readonly goal: ThreadGoal | null | undefined;
  readonly supported: boolean;
  readonly disabled?: boolean;
  readonly onSet: (objective: string) => Promise<boolean>;
  readonly onStatusChange: (status: "active" | "paused") => Promise<boolean>;
  readonly onClear: () => Promise<boolean>;
}

const STATUS_LABELS: Record<ThreadGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Budget limit",
  complete: "Complete",
};

function usageLabel(goal: ThreadGoal): string | null {
  if (goal.tokenBudget !== null) {
    return `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens`;
  }
  if (goal.tokensUsed > 0) {
    return `${goal.tokensUsed.toLocaleString()} tokens`;
  }
  if (goal.timeUsedSeconds > 0) {
    return `${Math.max(1, Math.round(goal.timeUsedSeconds / 60))}m`;
  }
  return null;
}

export function ThreadGoalBar({
  goal,
  supported,
  disabled = false,
  onSet,
  onStatusChange,
  onClear,
}: ThreadGoalBarProps) {
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!editing) {
      setObjective(goal?.objective ?? "");
    }
  }, [editing, goal?.objective]);

  if (!supported && !goal) {
    return null;
  }

  const submit = async () => {
    const trimmed = objective.trim();
    if (!trimmed || trimmed.length > 4_000) return;
    setPending(true);
    const succeeded = await onSet(trimmed);
    setPending(false);
    if (succeeded) setEditing(false);
  };

  if (!goal && !editing) {
    return (
      <div className="mb-1.5 flex justify-end">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          className="gap-1.5 rounded-full bg-card/75 text-muted-foreground shadow-sm backdrop-blur"
          onClick={() => setEditing(true)}
        >
          <TargetIcon className="size-3.5" />
          Set goal
        </Button>
      </div>
    );
  }

  if (!goal || editing) {
    return (
      <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-border/55 bg-card/85 px-2.5 py-2 shadow-sm backdrop-blur">
        <TargetIcon className="size-4 shrink-0 text-sky-500" />
        <Input
          autoFocus={editing}
          value={objective}
          maxLength={4_000}
          placeholder="What should Codex keep working toward?"
          aria-label="Goal objective"
          disabled={disabled || pending}
          className="h-7 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
          onChange={(event) => setObjective(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              setEditing(false);
              setObjective(goal?.objective ?? "");
            }
          }}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Save goal"
          disabled={disabled || pending || objective.trim().length === 0}
          onClick={() => void submit()}
        >
          <CheckIcon />
        </Button>
        {goal ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Cancel editing goal"
            disabled={pending}
            onClick={() => {
              setEditing(false);
              setObjective(goal.objective);
            }}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
    );
  }

  const usage = usageLabel(goal);
  const canPause = goal.status === "active";
  const canResume =
    goal.status === "paused" ||
    goal.status === "blocked" ||
    goal.status === "usageLimited" ||
    goal.status === "budgetLimited";

  return (
    <div className="mb-1.5 flex min-h-10 items-center gap-2 rounded-xl border border-border/55 bg-card/85 px-3 py-2 shadow-sm backdrop-blur">
      <TargetIcon
        className={cn(
          "size-4 shrink-0",
          goal.status === "complete" ? "text-emerald-500" : "text-sky-500",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm" title={goal.objective}>
        {goal.objective}
      </span>
      {usage ? (
        <span className="hidden text-muted-foreground text-xs sm:inline">{usage}</span>
      ) : null}
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        {STATUS_LABELS[goal.status]}
      </span>
      {canPause || canResume ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={canPause ? "Pause goal" : "Resume goal"}
          disabled={disabled || pending}
          onClick={() => {
            setPending(true);
            void onStatusChange(canPause ? "paused" : "active").finally(() => setPending(false));
          }}
        >
          {canPause ? <PauseIcon /> : <PlayIcon />}
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Edit goal"
        disabled={disabled || pending}
        onClick={() => setEditing(true)}
      >
        <PencilIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Clear goal"
        disabled={disabled || pending}
        onClick={() => {
          setPending(true);
          void onClear().finally(() => setPending(false));
        }}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
