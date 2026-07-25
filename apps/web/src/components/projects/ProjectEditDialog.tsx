/**
 * Editing what a project *is* — the half that travels to every machine.
 *
 * Only display fields are here, and that is a boundary rather than a v1 cut:
 * bindings, filed threads and the master name ids that mean something on one
 * machine and nothing anywhere else, so they are edited where they live, not in
 * a dialog that fans its result out to four servers.
 *
 * The slug is shown and not editable. It is the join key across machines, and
 * a key that can change is a key that can disagree — renaming here changes the
 * title, which is what an operator actually wants when they say "rename".
 *
 * Notes are the piece that makes "organized through the tool calls" true in
 * both directions: a human writes what the project is, and `project_get` hands
 * that same text to every agent that asks.
 */
import type { ProjectCategoryDisplayPatch } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

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
import { Textarea } from "../ui/textarea";
import type { ProjectCategoryView } from "./ProjectCatalog.model";

interface LinkDraft {
  readonly label: string;
  readonly url: string;
}

export function ProjectEditDialog({
  open,
  onOpenChange,
  project,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: ProjectCategoryView;
  readonly onSave: (patch: ProjectCategoryDisplayPatch) => Promise<void>;
}): ReactNode {
  const [title, setTitle] = useState(project.display.title);
  const [summary, setSummary] = useState(project.display.summary);
  const [notes, setNotes] = useState(project.display.notes);
  const [links, setLinks] = useState<ReadonlyArray<LinkDraft>>(project.display.links);
  const [saving, setSaving] = useState(false);

  // Re-seed on open rather than on every prop change: the catalog polls, so a
  // refresh landing mid-edit would otherwise overwrite what is being typed.
  useEffect(() => {
    if (!open) return;
    setTitle(project.display.title);
    setSummary(project.display.summary);
    setNotes(project.display.notes);
    setLinks(project.display.links);
  }, [open, project.display]);

  const save = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    try {
      await onSave({
        title: trimmed,
        summary: summary.trim(),
        notes,
        // A half-typed row is not a link. Dropping it silently beats saving a
        // label that points nowhere.
        links: links
          .filter((link) => link.label.trim().length > 0 && link.url.trim().length > 0)
          .map((link) => ({ label: link.label.trim(), url: link.url.trim() })),
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>
            These travel to every connected machine. Folders and filed threads stay where they are —
            they only mean something on the machine that holds them.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-title">Name</Label>
              <Input
                id="project-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground/60">
                Filed under <span className="font-mono">{project.slug}</span> on every machine. That
                never changes, so renaming here is safe.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-summary">Summary</Label>
              <Input
                id="project-summary"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="One line, shown on the card"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-notes">Notes</Label>
              <Textarea
                id="project-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={5}
                placeholder="What this project is, for you and for any agent that asks"
              />
              <p className="text-[11px] text-muted-foreground/60">
                Readable by the project tools, so an agent working here can look up what it is
                working on.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Links</Label>
              <ul className="space-y-1.5">
                {links.map((link, index) => (
                  // Index-keyed on purpose: these rows have no identity of
                  // their own until they are saved, and keying on a
                  // half-typed URL would remount the input mid-word.
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={index} className="flex items-center gap-1.5">
                    <Input
                      value={link.label}
                      onChange={(event) =>
                        setLinks((current) =>
                          current.map((entry, position) =>
                            position === index ? { ...entry, label: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="Label"
                      className="w-32 shrink-0"
                      aria-label={`Link ${index + 1} label`}
                    />
                    <Input
                      value={link.url}
                      onChange={(event) =>
                        setLinks((current) =>
                          current.map((entry, position) =>
                            position === index ? { ...entry, url: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="https://"
                      className="min-w-0 flex-1"
                      aria-label={`Link ${index + 1} URL`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0"
                      onClick={() =>
                        setLinks((current) => current.filter((_, position) => position !== index))
                      }
                      aria-label={`Remove link ${index + 1}`}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setLinks((current) => [...current, { label: "", url: "" }])}
              >
                <PlusIcon className="size-3" />
                Add link
              </Button>
            </div>
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || title.trim().length === 0}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
