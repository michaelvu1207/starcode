/**
 * Creating a project by hand.
 *
 * The counterpart to seeding: a project that is not a repository. Michael's
 * "not folder-related" case — a research thread, a reading list, an
 * investigation whose work lives in scratch directories — is exactly what this
 * makes possible, and it is why a category with zero bindings is a legal state
 * rather than an empty one.
 *
 * The slug is shown as it is typed, because it is permanent and because a
 * collision is a thing to see before pressing the button rather than discover
 * afterwards.
 */
import { toProjectCategorySlug } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

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
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function ProjectCreateDialog({
  open,
  onOpenChange,
  takenSlugs,
  onCreate,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly takenSlugs: ReadonlySet<string>;
  readonly onCreate: (title: string) => Promise<void>;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) setTitle("");
  }, [open]);

  /**
   * The slug this name will actually get, collisions and all.
   *
   * Computed with the same suffix rule the writer uses, so what is shown here
   * is what is written — two implementations of "already taken" would be one
   * too many.
   */
  const slug = useMemo(() => {
    const base = toProjectCategorySlug(title);
    if (base === null) return null;
    let candidate: string = base;
    let suffix = 2;
    while (takenSlugs.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }, [takenSlugs, title]);

  const submit = async () => {
    if (slug === null) return;
    setCreating(true);
    try {
      await onCreate(title);
      onOpenChange(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project groups threads across machines. It does not need a folder — bind one later, or
            file threads into it by hand.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel scrollFade={false}>
          <div className="space-y-1.5">
            <Label htmlFor="new-project-title">Name</Label>
            <Input
              id="new-project-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && slug !== null) void submit();
              }}
              placeholder="Alpamayo"
              autoFocus
            />
            <p className="min-h-4 text-[11px] text-muted-foreground/60">
              {slug === null ? (
                title.length === 0 ? (
                  ""
                ) : (
                  "That name has no letters or numbers to file it under."
                )
              ) : (
                <>
                  Filed under <span className="font-mono">{slug}</span> on every machine.
                  {slug !== toProjectCategorySlug(title)
                    ? " That name is taken, so this one gets a suffix."
                    : ""}
                </>
              )}
            </p>
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={creating || slug === null}>
            {creating ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
