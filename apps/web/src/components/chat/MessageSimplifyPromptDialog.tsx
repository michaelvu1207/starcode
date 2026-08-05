import {
  DEFAULT_MESSAGE_SIMPLIFICATION_INSTRUCTIONS,
  MESSAGE_SIMPLIFICATION_INSTRUCTIONS_MAX_LENGTH,
} from "@starcode/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

export function MessageSimplifyPromptDialog({
  open,
  instructions,
  onOpenChange,
  onSave,
}: {
  readonly open: boolean;
  readonly instructions: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (instructions: string) => void;
}) {
  const [draft, setDraft] = useState(instructions);
  useEffect(() => {
    if (open) setDraft(instructions);
  }, [instructions, open]);

  const trimmed = draft.trim();
  const canSave =
    trimmed.length > 0 && trimmed.length <= MESSAGE_SIMPLIFICATION_INSTRUCTIONS_MAX_LENGTH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit Simplify prompt</DialogTitle>
          <DialogDescription>
            These preferences apply to every Simplify request in this browser. Source-message and
            structured-output safeguards remain fixed.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <div className="space-y-2">
            <Label htmlFor="message-simplify-instructions">Instructions</Label>
            <Textarea
              id="message-simplify-instructions"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              autoFocus
              aria-describedby="message-simplify-instructions-count"
            />
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground/70">
              <span>Describe what the shorter response should retain and how it should read.</span>
              <span id="message-simplify-instructions-count" className="shrink-0 tabular-nums">
                {draft.length}/{MESSAGE_SIMPLIFICATION_INSTRUCTIONS_MAX_LENGTH}
              </span>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDraft(DEFAULT_MESSAGE_SIMPLIFICATION_INSTRUCTIONS)}
          >
            Reset to default
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canSave}
              onClick={() => {
                onSave(trimmed);
                onOpenChange(false);
              }}
            >
              Save prompt
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
