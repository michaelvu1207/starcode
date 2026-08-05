/**
 * Seeding: turning the repositories you already have into projects, once.
 *
 * Without this the view is empty on day one and wrong on day two, so it is not
 * an optional convenience — it is how the feature starts working. The proposals
 * are a pure fold over data the client already holds; nothing here asks a
 * machine anything.
 *
 * **Repository matches are pre-checked; path matches are not.** A shared
 * `canonicalKey` means the same git remote on two machines, which is a fact. A
 * shared folder name means two folders are called `api`, which is a guess — and
 * a wrong merge is the one mistake this flow must not make, because undoing it
 * means removing a project on four machines by hand. So the weak ones are
 * listed, marked, and left for the operator to opt into.
 *
 * Slug collisions are stated rather than discovered: when two repositories want
 * the same name the second says "will be created as api-2" on its own row,
 * before anything is written.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProjectGlyph } from "./ProjectGlyph";
import type { ProjectSeedProposal } from "./ProjectCatalog.model";
import { projectAccentHue } from "./ProjectMark.model";
import "./Projects.css";

export function ProjectSeedDialog({
  open,
  onOpenChange,
  proposals,
  onSeed,
  seeding,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly proposals: ReadonlyArray<ProjectSeedProposal>;
  readonly onSeed: (accepted: ReadonlyArray<ProjectSeedProposal>) => void;
  readonly seeding: boolean;
}): ReactNode {
  const strong = useMemo(
    () => proposals.filter((proposal) => proposal.evidence === "repository"),
    [proposals],
  );
  const weak = useMemo(
    () => proposals.filter((proposal) => proposal.evidence === "path"),
    [proposals],
  );

  // Repository matches start checked, path matches start unchecked. Reset every
  // time the dialog opens: the proposals behind it are recomputed on every
  // poll, and a stale selection could tick a row the operator never saw.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(strong.map((proposal) => proposal.slug)));
  }, [open, strong]);

  const toggle = (slug: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  const accepted = proposals.filter((proposal) => selected.has(proposal.slug));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up your projects</DialogTitle>
          <DialogDescription>
            Every repository your machines are working in, grouped across all of them. Accept and
            each becomes a project bound to the folders it was found in.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {proposals.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing left to set up — every folder your machines know about is already filed.
            </p>
          ) : (
            <div className="space-y-5">
              {strong.length > 0 ? (
                <SeedGroup
                  title="Same repository"
                  caption="These folders share a git remote, so they are the same work in different places."
                  proposals={strong}
                  selected={selected}
                  onToggle={toggle}
                />
              ) : null}

              {weak.length > 0 ? (
                <SeedGroup
                  title="Same folder name"
                  caption="No git remote to go on — only the folder name matches. Check the ones that really are the same project."
                  proposals={weak}
                  selected={selected}
                  onToggle={toggle}
                />
              ) : null}
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={seeding}>
            Not now
          </Button>
          <Button
            onClick={() => onSeed(accepted)}
            disabled={seeding || accepted.length === 0}
            data-testid="projects-seed-accept"
          >
            {seeding
              ? "Creating…"
              : accepted.length === 1
                ? "Create 1 project"
                : `Create ${accepted.length} projects`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SeedGroup({
  title,
  caption,
  proposals,
  selected,
  onToggle,
}: {
  readonly title: string;
  readonly caption: string;
  readonly proposals: ReadonlyArray<ProjectSeedProposal>;
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (slug: string) => void;
}): ReactNode {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-xs font-medium text-foreground">{title}</h3>
        <p className="text-[11px] text-muted-foreground/70">{caption}</p>
      </div>
      <ul className="space-y-1.5">
        {proposals.map((proposal) => {
          const checked = selected.has(proposal.slug);
          // The slug only earns a mention when it is not simply the title
          // lowercased — which is exactly the collision case, and exactly when
          // an operator would otherwise be surprised later.
          const renamed = proposal.slug !== proposal.title.toLowerCase();
          return (
            <li key={proposal.slug}>
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                  checked ? "border-border bg-muted/40" : "border-border/50 hover:bg-muted/25",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onToggle(proposal.slug)}
                  className="mt-0.5"
                  aria-label={`Create the ${proposal.title} project`}
                />
                <span
                  className="sc-project-mark mt-0.5 size-4 shrink-0"
                  style={{ "--sc-project-hue": `${projectAccentHue(proposal.slug)}deg` } as never}
                >
                  <ProjectGlyph slug={proposal.slug} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {proposal.title}
                    </span>
                    {renamed ? (
                      <span className="text-[11px] text-muted-foreground/70">
                        will be created as {proposal.slug}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground/75">
                    {proposal.locations.length === 1
                      ? proposal.locations[0]!.label
                      : `${proposal.locations.length} machines · ${proposal.locations
                          .map((location) => location.label)
                          .join(", ")}`}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/55">
                    {proposal.locations[0]!.workspaceRoot}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
