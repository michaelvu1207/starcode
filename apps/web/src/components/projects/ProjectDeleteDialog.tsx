/**
 * Deleting a project category.
 *
 * The one thing this dialog exists to say, and says twice: **no thread is
 * deleted.** A category is a label held over threads that live somewhere else —
 * in folders, on machines, in a git history none of this touches — so removing
 * it removes the label and nothing under it. The threads come back as Chats.
 * Without that stated plainly, "Delete project" reads like "delete a week of
 * work", and an operator who believes that will never press it (or will press
 * it once and never trust the app again).
 *
 * The second thing it handles is partial success. The category lives in one
 * registry file per machine, so deleting it is a fan-out, and a fan-out over
 * four machines has more outcomes than "done". A machine that was asleep still
 * holds the category and will hand it back to the fold on its next poll, which
 * looks exactly like the delete silently undoing itself. So the dialog stays
 * open on partial failure, names the machines that refused and why, and offers
 * to try again. The retry re-runs the whole fan-out rather than only the
 * failures: removing a slug a machine no longer has is a no-op, and a fan-out
 * with one code path is worth more than one that saves three requests.
 */
import type { EnvironmentId, ProjectCategorySlug } from "@starcode/contracts";
import { useEffect, useState, type ReactNode } from "react";

import type { ProjectCatalogFanOutResult } from "../../state/projectCatalog";
import { Button } from "../ui/button";
import {
  PROJECT_DELETE_GUARANTEES,
  projectDeleteConsequence,
  projectDeleteRefusalHeadline,
  projectDeleteUnreachableNote,
} from "./ProjectDelete.copy";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function ProjectDeleteDialog({
  open,
  onOpenChange,
  slug,
  title,
  threadCount,
  unreachableLabels,
  environmentLabelById,
  onDelete,
  onDeleted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly slug: ProjectCategorySlug;
  readonly title: string;
  /** How many threads lose their label. Zero is worth saying out loud too. */
  readonly threadCount: number;
  /**
   * Machines the fold could not read. The delete cannot reach them, so they
   * keep the category and hand it back — the same outcome as a refusal, but
   * knowable before the button rather than after it.
   */
  readonly unreachableLabels: ReadonlyArray<string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly onDelete: (slug: ProjectCategorySlug) => Promise<ProjectCatalogFanOutResult>;
  /** Called once every machine has taken it, for the caller to navigate away. */
  readonly onDeleted?: () => void;
}): ReactNode {
  const [deleting, setDeleting] = useState(false);
  const [refusals, setRefusals] = useState<
    ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly message: string }>
  >([]);

  useEffect(() => {
    if (open) setRefusals([]);
  }, [open]);

  const submit = async () => {
    setDeleting(true);
    try {
      const result = await onDelete(slug);
      if (result.refusals.length === 0) {
        onOpenChange(false);
        onDeleted?.();
        return;
      }
      setRefusals(result.refusals);
    } finally {
      setDeleting(false);
    }
  };

  const attempted = refusals.length > 0;
  const unreachable = projectDeleteUnreachableNote(unreachableLabels);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {title}?</DialogTitle>
          <DialogDescription>
            {projectDeleteConsequence(threadCount, unreachableLabels.length)}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel scrollFade={false}>
          <ul className="space-y-1 text-[11px] text-muted-foreground/70">
            {PROJECT_DELETE_GUARANTEES.map((guarantee) => (
              <li key={guarantee}>{guarantee}</li>
            ))}
          </ul>

          {unreachable === null ? null : (
            <p
              data-testid="project-delete-unreachable"
              className="mt-3 rounded-md border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground"
            >
              {unreachable}
            </p>
          )}

          {attempted ? (
            <div
              data-testid="project-delete-refusals"
              className="mt-3 space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2"
            >
              <p className="text-[11px] font-medium text-destructive">
                {projectDeleteRefusalHeadline(refusals.length)}
              </p>
              <ul className="space-y-0.5">
                {refusals.map((refusal) => (
                  <li key={refusal.environmentId} className="text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/85">
                      {environmentLabelById.get(refusal.environmentId) ?? refusal.environmentId}
                    </span>
                    {" — "}
                    {refusal.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            {attempted ? "Leave it" : "Cancel"}
          </Button>
          <Button
            variant="destructive"
            data-testid="project-delete-confirm"
            onClick={() => void submit()}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : attempted ? "Try those again" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
