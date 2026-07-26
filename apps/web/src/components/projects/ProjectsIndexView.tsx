/**
 * `/projects` — every project, across every machine.
 *
 * A card grid rather than a sky. The sky is for one project's work in flight,
 * where position carries meaning; this page answers "which of these needs me",
 * and for that a grid you can scan beats a picture you have to read.
 *
 * The cards are sorted by who is waiting on a human, which is the only reason
 * to open this page rather than going straight to a thread.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useEnvironments } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  useProjectCards,
  useProjectCatalogView,
  useProjectMembership,
  useProjectSeedPlan,
} from "../../state/projectCatalog";
import { SkySpecks } from "../brand/CelestialArt";
import { Button } from "../ui/button";
import { WORKBENCH_TONE_DOT_CLASS, type WorkbenchTone } from "../workbench/Workbench.tone";
import { ProjectGlyph } from "./ProjectGlyph";
import type { ProjectBindSuggestion, ProjectSeedProposal } from "./ProjectCatalog.model";
import { projectAccentHue, type ProjectCard } from "./ProjectsIndex.model";
import { ProjectCreateDialog } from "./ProjectCreateDialog";
import { ProjectSeedDialog } from "./ProjectSeedDialog";
import { useProjectWriter } from "./useProjectWriter";
import "./Projects.css";

export function ProjectsIndexView(): ReactNode {
  const view = useProjectCatalogView();
  const membership = useProjectMembership(view);
  const cards = useProjectCards(view, membership);
  const seedPlan = useProjectSeedPlan(view);
  const writer = useProjectWriter();

  const navigate = useNavigate();
  const [seeding, setSeeding] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const takenSlugs = useMemo(
    () => new Set(view.projects.map((project) => project.slug)),
    [view.projects],
  );
  const live = cards.filter((card) => !card.archived);
  const archived = cards.filter((card) => card.archived);
  const unfiledCount = membership.unfiledThreadKeys.length;

  const runSeed = useCallback(
    async (accepted: ReadonlyArray<ProjectSeedProposal>) => {
      setSeeding(true);
      try {
        await writer.seed(accepted);
        setSeedOpen(false);
      } finally {
        setSeeding(false);
      }
    },
    [writer],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <SkySpecks />
      </div>

      <header className="relative z-10 flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3">
        <h1 className="text-sm font-medium text-foreground">Projects</h1>
        <span className="text-[11px] text-muted-foreground/60">
          {live.length === 0
            ? "nothing filed yet"
            : `${live.length} ${live.length === 1 ? "project" : "projects"} across your machines`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {seedPlan.proposals.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setSeedOpen(true)}>
              <FolderPlusIcon className="size-3.5" />
              Set up {seedPlan.proposals.length}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-3.5" />
            New project
          </Button>
        </div>
      </header>

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* The machines that cannot answer, named once at the top rather than
            repeated on every card. Three different silences, three sentences —
            an old server is not the same event as an unreachable one. */}
        {view.notes.length > 0 ? (
          <ul className="mb-4 space-y-1">
            {view.notes.map((note) => (
              <li key={note.environmentId} className="text-[11px] text-muted-foreground/60">
                {note.reason === "pending"
                  ? `${note.label} has not answered yet.`
                  : note.reason === "unsupported"
                    ? `${note.label} does not report projects yet — it needs a server update.`
                    : `${note.label} is connected but could not be read.`}
              </li>
            ))}
          </ul>
        ) : null}

        {seedPlan.bindSuggestions.length > 0 ? (
          <BindStrip suggestions={seedPlan.bindSuggestions} onBind={writer.bind} />
        ) : null}

        {live.length === 0 && unfiledCount === 0 ? (
          <EmptyIndex
            hasProposals={seedPlan.proposals.length > 0}
            onSeed={() => setSeedOpen(true)}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {live.map((card) => (
              <ProjectCardTile key={card.slug} card={card} />
            ))}
            {unfiledCount > 0 ? <UnfiledTile count={unfiledCount} /> : null}
          </div>
        )}

        {archived.length > 0 ? (
          <section className="mt-6">
            <button
              type="button"
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 hover:text-foreground"
              onClick={() => setShowArchived((current) => !current)}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", !showArchived && "-rotate-90")}
              />
              {archived.length} archived
            </button>
            {showArchived ? (
              <div className="mt-3 grid gap-3 opacity-70 sm:grid-cols-2 xl:grid-cols-3">
                {archived.map((card) => (
                  <ProjectCardTile key={card.slug} card={card} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <ProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        takenSlugs={takenSlugs}
        onCreate={async (title) => {
          const slug = await writer.create(title);
          // Straight into the new project rather than back to a grid where it
          // is one card among twelve: creating one is always the first step of
          // doing something with it.
          if (slug !== null) void navigate({ to: "/projects/$slug", params: { slug } });
        }}
      />

      <ProjectSeedDialog
        open={seedOpen}
        onOpenChange={setSeedOpen}
        proposals={seedPlan.proposals}
        onSeed={(accepted) => void runSeed(accepted)}
        seeding={seeding}
      />
    </div>
  );
}

function ProjectCardTile({ card }: { readonly card: ProjectCard }): ReactNode {
  const machines = card.machines.filter((machine) => machine.carriesWork);
  const stageLine = [
    card.stages.inDev > 0 ? `${card.stages.inDev} in dev` : null,
    card.stages.inStaging > 0 ? `${card.stages.inStaging} in staging` : null,
    card.stages.inProduction > 0 ? `${card.stages.inProduction} shipped` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <Link
      to="/projects/$slug"
      params={{ slug: card.slug }}
      className={cn(
        "sc-project-card group flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/70 px-3.5 py-3 transition-colors hover:border-border hover:bg-card",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      data-testid={`project-card-${card.slug}`}
    >
      <div className="relative z-10 flex items-start gap-2.5">
        <span
          className="sc-project-mark mt-px size-7 shrink-0"
          style={{ "--sc-project-hue": `${projectAccentHue(card.slug, card.accent)}deg` } as never}
        >
          <ProjectGlyph slug={card.slug} variant={card.glyph} icon={card.icon} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{card.title}</span>
          {card.summary.length > 0 ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70">
              {card.summary}
            </span>
          ) : null}
        </span>
        {/* The badge the page exists for. Present only when something is
            actually waiting — a zero here would be noise on every other card. */}
        {card.attentionCount > 0 ? (
          <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            {card.attentionCount} waiting
          </span>
        ) : null}
      </div>

      <div className="relative z-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              WORKBENCH_TONE_DOT_CLASS[card.tone as WorkbenchTone],
            )}
          />
          {card.activeCount === 0
            ? "nothing running"
            : `${card.activeCount} ${card.activeCount === 1 ? "thread" : "threads"}${
                card.workingCount > 0 ? ` · ${card.workingCount} working` : ""
              }`}
        </span>
        {stageLine.length > 0 ? <span>{stageLine}</span> : null}
        {/* Last, and only when there is one: recency is how you tell a project
            you left yesterday from one you left in March, but it is the least
            of the three and a project nobody has touched has nothing to say. */}
        {card.lastActivityAt !== null ? (
          <span className="ml-auto text-muted-foreground/55">
            {formatRelativeTimeLabel(card.lastActivityAt)}
          </span>
        ) : null}
      </div>

      {machines.length > 0 ? (
        <div className="relative z-10 flex flex-wrap gap-1">
          {machines.map((machine) => (
            <span
              key={machine.environmentId}
              className={cn(
                "rounded border border-border/50 px-1.5 py-px text-[10px] text-muted-foreground/70",
                machine.isLocal && "border-border text-foreground/80",
              )}
            >
              {machine.label}
            </span>
          ))}
        </div>
      ) : null}
    </Link>
  );
}

/**
 * Threads no project claims.
 *
 * Not styled as a project, because it is not one — it is a queue. It links into
 * the sidebar's own unfiled view rather than pretending to be a project home.
 */
function UnfiledTile({ count }: { readonly count: number }): ReactNode {
  return (
    <div className="flex flex-col justify-center gap-1 rounded-lg border border-dashed border-border/60 px-3.5 py-3">
      <span className="text-sm font-medium text-muted-foreground">Unfiled</span>
      <span className="text-[11px] text-muted-foreground/70">
        {count} {count === 1 ? "thread belongs" : "threads belong"} to no project yet. Bind their
        folder to one, or file them from the thread.
      </span>
    </div>
  );
}

/**
 * Locations that look like they belong to a project that already exists.
 *
 * A strip rather than part of the seeding dialog: this is a standing condition
 * — a machine reconnects, a folder is added — not a one-time setup step, and
 * burying it in a dialog nobody reopens would mean it never gets acted on.
 */
function BindStrip({
  suggestions,
  onBind,
}: {
  readonly suggestions: ReadonlyArray<ProjectBindSuggestion>;
  readonly onBind: (suggestion: ProjectBindSuggestion) => void;
}): ReactNode {
  const { environments } = useEnvironments();
  const labelOf = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );

  return (
    <ul className="mb-4 space-y-1.5">
      {suggestions.map((suggestion) => (
        <li
          key={`${suggestion.slug}:${suggestion.location.environmentId}:${suggestion.location.projectId}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/50 bg-card/50 px-3 py-2 text-[11px]"
        >
          <span className="text-muted-foreground/80">
            <span className="font-mono text-muted-foreground">
              {suggestion.location.workspaceRoot}
            </span>{" "}
            on {labelOf.get(suggestion.location.environmentId) ?? suggestion.location.label} looks
            like <span className="text-foreground">{suggestion.slug}</span>
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
            onClick={() => onBind(suggestion)}
          >
            Bind
          </Button>
        </li>
      ))}
    </ul>
  );
}

function EmptyIndex({
  hasProposals,
  onSeed,
}: {
  readonly hasProposals: boolean;
  readonly onSeed: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <p className="text-sm text-muted-foreground/80">No projects yet</p>
      <p className="max-w-md text-xs text-muted-foreground/55">
        A project groups work across machines — the same repository on your laptop and on a GPU box
        is one project, not four. Threads file themselves once a folder is bound.
      </p>
      {hasProposals ? (
        <Button size="sm" onClick={onSeed}>
          Set up from your repositories
        </Button>
      ) : null}
    </div>
  );
}
