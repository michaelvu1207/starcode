import { LoaderCircleIcon, PencilIcon } from "lucide-react";
import { memo, useRef } from "react";

import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

export const MessageSimplifyButton = memo(function MessageSimplifyButton({
  pending,
  showingSummary,
  onToggle,
  onEditPrompt,
}: {
  pending: boolean;
  showingSummary: boolean;
  onToggle: (anchor: HTMLButtonElement) => void;
  onEditPrompt: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const label = pending ? "Simplifying…" : showingSummary ? "Show original" : "Simplify";

  return (
    <div className="flex items-center gap-0.5">
      <Button
        ref={ref}
        type="button"
        size="xs"
        variant="ghost"
        disabled={pending}
        aria-label={label}
        aria-pressed={showingSummary}
        onClick={() => {
          if (ref.current) onToggle(ref.current);
        }}
        className={cn(
          "h-6 gap-1 px-1.5 font-normal text-muted-foreground text-xs hover:text-foreground",
          showingSummary && "text-foreground",
        )}
      >
        {pending ? <LoaderCircleIcon aria-hidden className="size-3 animate-spin" /> : null}
        {label}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={pending}
        aria-label="Edit Simplify prompt"
        title="Edit Simplify prompt"
        onClick={onEditPrompt}
        className="size-6 text-muted-foreground hover:text-foreground"
      >
        <PencilIcon aria-hidden className="size-3" />
      </Button>
    </div>
  );
});
