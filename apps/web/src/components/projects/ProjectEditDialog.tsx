/**
 * Editing what a project *is* — the half that travels to every machine.
 *
 * Display fields are the bulk of it, and that is a boundary rather than a v1
 * cut: filed threads and the master name ids that mean something on one machine
 * and nothing anywhere else, so they are set where they live, not in a dialog
 * that fans its result out to four servers.
 *
 * The one machine-local thing that *is* here is binding a suggested folder, and
 * it is here because F16.6 deleted the strip on the index that used to carry
 * it. A suggestion is a standing condition — a machine reconnects, a folder
 * appears — so it needs a surface that outlives first-run setup, and this is the
 * only one that already has a project in front of it. It writes to exactly one
 * machine, which is why it sits below a rule rather than among the fields Save
 * fans out.
 *
 * The slug is shown and not editable. It is the join key across machines, and
 * a key that can change is a key that can disagree — renaming here changes the
 * title, which is what an operator actually wants when they say "rename".
 *
 * Notes are the piece that makes "organized through the tool calls" true in
 * both directions: a human writes what the project is, and `project_get` hands
 * that same text to every agent that asks.
 *
 * Archive and delete moved in here in F16.6, when the project home lost its
 * header strip. They are the two things you do to a project that are not
 * editing it, and this dialog is now the only surface that has a project rather
 * than a thread in front of it — so it is where they have to live or they are
 * unreachable. They sit at the bottom, behind a rule, in that order: archive is
 * the answer to "I am done with this for now" and seeing it beside delete is
 * what makes that obvious.
 */
import type { ProjectCategoryDisplayPatch } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, ImagePlusIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useEnvironments } from "../../state/environments";
import {
  useProjectCatalogView,
  useProjectMembership,
  useProjectSeedPlan,
} from "../../state/projectCatalog";
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
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { encodeProjectIcon } from "./projectIconEncode";
import { ProjectGlyph } from "./ProjectGlyph";
import { PROJECT_ACCENTS, PROJECT_GLYPH_VARIANTS, projectAccentHue } from "./ProjectMark.model";
import { useProjectWriter } from "./useProjectWriter";
import "./Projects.css";

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
  const [accent, setAccent] = useState(project.display.accent);
  const [glyph, setGlyph] = useState(project.display.glyph);
  const [icon, setIcon] = useState(project.display.icon);
  const [iconError, setIconError] = useState("");
  const [encoding, setEncoding] = useState(false);
  const [notes, setNotes] = useState(project.display.notes);
  const [links, setLinks] = useState<ReadonlyArray<LinkDraft>>(project.display.links);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const writer = useProjectWriter();

  // Re-seed on open rather than on every prop change: the catalog polls, so a
  // refresh landing mid-edit would otherwise overwrite what is being typed.
  //
  // The latch is what makes that true. `project.display` has to stay in the
  // dependency list — the dialog must show the current record when it opens —
  // but a poll hands back a new object every 45 seconds, and without the latch
  // the effect fires again and reverts the form. That was survivable when the
  // worst case was a re-typed sentence; an upload is a file the operator picked
  // and re-encoded, and losing it silently on a timer is not.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    setTitle(project.display.title);
    setSummary(project.display.summary);
    setAccent(project.display.accent);
    setGlyph(project.display.glyph);
    setIcon(project.display.icon);
    setIconError("");
    setNotes(project.display.notes);
    setLinks(project.display.links);
  }, [open, project.display]);

  const pickIcon = async (file: File | undefined) => {
    if (file === undefined) return;
    setIconError("");
    setEncoding(true);
    try {
      const result = await encodeProjectIcon(file);
      if (result.ok) setIcon(result.icon);
      else setIconError(result.message);
    } finally {
      setEncoding(false);
    }
  };

  // The figure swatches all wear the accent being edited, so choosing a figure
  // and choosing a colour are one decision seen twice rather than two.
  const hue = projectAccentHue(project.slug, accent);

  const save = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    try {
      await onSave({
        title: trimmed,
        summary: summary.trim(),
        accent,
        glyph,
        icon,
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
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              These travel to every connected machine. Folders and filed threads stay where they are
              — they only mean something on the machine that holds them.
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
                  Filed under <span className="font-mono">{project.slug}</span> on every machine.
                  That never changes, so renaming here is safe.
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

              {/* The mark, which is the only thing distinguishing one card from
                another at a glance. Both halves default to "derived from the
                slug", so this section is entirely optional — it exists for the
                operator who has two projects whose auto-figures look alike. */}
              <div className="space-y-2">
                <Label>Mark</Label>

                {/* The uploaded icon, when there is one, wins over everything
                  below it — so it goes first, at the size the sidebar and the
                  cards actually draw it rather than as a large preview that
                  flatters a picture nobody will see that big. */}
                <div className="flex items-center gap-2.5">
                  <span
                    className="sc-project-mark size-9 shrink-0 rounded-md border border-border/40 p-1"
                    style={{ "--sc-project-hue": `${hue}deg` } as never}
                    data-testid="project-icon-preview"
                  >
                    <ProjectGlyph slug={project.slug} variant={glyph} icon={icon} />
                  </span>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/webp,image/jpeg,image/gif,image/svg+xml"
                    className="hidden"
                    data-testid="project-icon-input"
                    onChange={(event) => {
                      void pickIcon(event.target.files?.[0]);
                      // Cleared so picking the same file twice still fires a
                      // change — the second attempt after a rejection is the one
                      // most likely to be the same file, re-exported.
                      event.target.value = "";
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    disabled={encoding}
                    onClick={() => fileInput.current?.click()}
                    data-testid="project-icon-upload"
                  >
                    <ImagePlusIcon className="size-3" />
                    {encoding ? "Shrinking…" : icon.length > 0 ? "Replace icon" : "Upload icon"}
                  </Button>
                  {icon.length > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px] text-muted-foreground"
                      onClick={() => {
                        setIcon("");
                        setIconError("");
                      }}
                      data-testid="project-icon-clear"
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                {iconError.length > 0 ? (
                  <p className="text-[11px] text-destructive" data-testid="project-icon-error">
                    {iconError}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground/60">
                    Shrunk to 96px square and stored with the project, so it shows on every machine.
                    {icon.length > 0 ? " The figures below apply when there is no icon." : ""}
                  </p>
                )}

                <div className="flex flex-wrap gap-1.5">
                  {PROJECT_GLYPH_VARIANTS.map((variant) => (
                    <button
                      key={variant === "" ? "auto" : variant}
                      type="button"
                      onClick={() => setGlyph(variant)}
                      aria-pressed={glyph === variant}
                      aria-label={variant === "" ? "Figure from the name" : `Figure ${variant}`}
                      className={cn(
                        "sc-project-mark size-9 rounded-md border p-1.5 transition-colors",
                        glyph === variant
                          ? "border-border bg-muted/50"
                          : "border-border/40 hover:bg-muted/25",
                      )}
                      style={{ "--sc-project-hue": `${hue}deg` } as never}
                    >
                      <ProjectGlyph slug={project.slug} variant={variant} />
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PROJECT_ACCENTS.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      onClick={() =>
                        // Clicking the accent a project already wears returns it
                        // to the derived one, so "undo" needs no separate control.
                        setAccent((current) => (current === choice.id ? "" : choice.id))
                      }
                      aria-pressed={accent === choice.id}
                      aria-label={choice.label}
                      title={choice.label}
                      className={cn(
                        "sc-project-mark size-6 rounded-full border transition-colors",
                        accent === choice.id ? "border-foreground/60" : "border-border/40",
                      )}
                      style={{ "--sc-project-hue": `${choice.hue}deg` } as never}
                    >
                      <span className="block size-full rounded-full bg-current opacity-80" />
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground/60">
                  {accent === "" && glyph === ""
                    ? "Both come from the name. Pick a figure or a colour to override either."
                    : "Click the selected colour again to go back to the one the name gives."}
                </p>
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

              {/* Only while the dialog is open: the suggestions come from a
                second poll, and every project row in the sidebar keeps one of
                these dialogs mounted. */}
              {open ? <ProjectBindSuggestions project={project} /> : null}

              {/* The two things that are not edits. Behind a rule and last,
                because a dialog you open to rename something should not put
                "Delete project" where the eye lands first. */}
              <div className="space-y-2.5 border-t border-border/50 pt-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">
                      {project.archived ? "Unarchive" : "Archive"}
                    </p>
                    <p className="text-[11px] text-muted-foreground/60">
                      {project.archived
                        ? "Puts it back with your live projects."
                        : "Hides it behind the sidebar's archived disclosure. Its threads stay where they are."}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-[11px]"
                    disabled={archiving}
                    data-testid="project-archive"
                    onClick={() => {
                      setArchiving(true);
                      void writer
                        .setArchived(project.slug, !project.archived)
                        .finally(() => setArchiving(false));
                    }}
                  >
                    <ArchiveIcon className="size-3" />
                    {project.archived ? "Unarchive" : "Archive"}
                  </Button>
                </div>

                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Delete</p>
                    <p className="text-[11px] text-muted-foreground/60">
                      Removes the name from every machine. No thread is deleted — they come back as
                      Chats.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                    data-testid="project-delete"
                    onClick={() => {
                      // The confirm replaces this dialog rather than stacking on
                      // it: two popups deep is where an operator loses track of
                      // which one the Escape key closes.
                      onOpenChange(false);
                      setConfirmingDelete(true);
                    }}
                  >
                    <Trash2Icon className="size-3" />
                    Delete project
                  </Button>
                </div>
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

      {/* Mounted only while it is open, so the membership fold and the
          environment list it needs are not computed once per project row for a
          dialog nobody has asked for. */}
      {confirmingDelete ? (
        <ProjectDeleteConfirm project={project} onClose={() => setConfirmingDelete(false)} />
      ) : null}
    </>
  );
}

/**
 * Folders on some machine that look like this project and are not bound to it.
 *
 * The fold already computes these for the whole fleet; this only shows the ones
 * wearing this project's slug. Evidence is stated rather than smoothed over: a
 * shared git remote is a fact, a shared folder name is a guess, and the guess
 * says so on its own row — binding the wrong folder is the mistake that takes a
 * hand-edit on four machines to undo.
 */
function ProjectBindSuggestions({ project }: { readonly project: ProjectCategoryView }): ReactNode {
  const view = useProjectCatalogView();
  const seedPlan = useProjectSeedPlan(view);
  const writer = useProjectWriter();
  // The catalog re-polls before a bound row disappears on its own, so the row
  // is dropped here the moment it is taken. Keyed by location, not by slug:
  // one project can have a suggestion per machine.
  const [bound, setBound] = useState<ReadonlySet<string>>(new Set());

  const suggestions = seedPlan.bindSuggestions.filter(
    (suggestion) =>
      suggestion.slug === project.slug &&
      !bound.has(`${suggestion.location.environmentId}:${suggestion.location.projectId}`),
  );
  if (suggestions.length === 0) return null;

  return (
    <div
      className="space-y-1.5 border-t border-border/50 pt-4"
      data-testid="project-bind-suggestions"
    >
      <Label>Suggested folders</Label>
      <ul className="space-y-1.5">
        {suggestions.map((suggestion) => (
          <li
            key={`${suggestion.location.environmentId}:${suggestion.location.projectId}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/50 bg-card/50 px-2.5 py-1.5 text-[11px]"
          >
            <span className="min-w-0 text-muted-foreground/80">
              <span className="font-mono text-muted-foreground">
                {suggestion.location.workspaceRoot}
              </span>{" "}
              on {suggestion.location.label}
            </span>
            {suggestion.evidence === "path" ? (
              <span className="rounded bg-muted/60 px-1 py-px text-[10px] text-muted-foreground/70">
                name only
              </span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px]"
              data-testid="project-bind-suggestion"
              onClick={() => {
                writer.bind(suggestion);
                setBound((current) =>
                  new Set(current).add(
                    `${suggestion.location.environmentId}:${suggestion.location.projectId}`,
                  ),
                );
              }}
            >
              Bind
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground/60">
        Binding one files its threads under this project on that machine. Nothing moves on disk.
      </p>
    </div>
  );
}

/**
 * The delete confirmation, wired to what the fold knows.
 *
 * It gathers its own facts — how many threads lose their label, which machines
 * could not be read — because the two places that open the edit dialog have a
 * project in hand and nothing else, and passing four more props through both of
 * them would only move this lookup, not remove it.
 */
function ProjectDeleteConfirm({
  project,
  onClose,
}: {
  readonly project: ProjectCategoryView;
  readonly onClose: () => void;
}): ReactNode {
  const view = useProjectCatalogView();
  const membership = useProjectMembership(view);
  const writer = useProjectWriter();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });

  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const threadCount = (membership.threadKeysBySlug.get(project.slug) ?? []).length;
  /** Machines the catalog fold could not read at all — see the delete dialog. */
  const unreachableLabels = useMemo(() => view.notes.map((note) => note.label), [view.notes]);

  return (
    <ProjectDeleteDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      slug={project.slug}
      title={project.display.title}
      threadCount={threadCount}
      // Every machine the fold could not read, not just the ones carrying this
      // project: a machine that did not answer cannot be asked whether it holds
      // the category, and reporting the count as if it could is the claim
      // invariant 12 forbids.
      unreachableLabels={unreachableLabels}
      environmentLabelById={environmentLabelById}
      onDelete={writer.remove}
      onDeleted={() => {
        onClose();
        // Only if you were standing in it. Deleting a project from the sidebar
        // while reading an unrelated thread must not move you.
        if (pathname.startsWith(`/projects/${encodeURIComponent(project.slug)}`)) {
          void navigate({ to: "/" });
        }
      }}
    />
  );
}
