/**
 * `/projects/$slug` — one project, everywhere it lives.
 *
 * The Workbench's sky with a membership filter and a header, which is the whole
 * point of the seam F14 left: the fleet view and a project view are the same
 * picture drawn over different sets, not two implementations of a star map.
 *
 * Three regions, in reading order: what this project *is* (header, editable),
 * what its work looks like right now (the sky), and the threads themselves as a
 * list you can click. The list is not redundant with the sky — the sky answers
 * "what shape is this project in", the list answers "take me to that thread",
 * and asking a constellation to be a table is how both stop working.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ProjectCategorySlug } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, ArrowLeftIcon, PencilIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useThreadShells } from "../../state/entities";
import { useProjectCatalogView, useProjectMembership } from "../../state/projectCatalog";
import { buildThreadRouteParams } from "../../threadRoutes";
import { resolveSidebarV2Status } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { WorkbenchStarMap } from "../workbench/WorkbenchStarMap";
import {
  WORKBENCH_TONE_DOT_CLASS,
  WORKBENCH_TONE_LABEL,
  toneForThreadStatus,
} from "../workbench/Workbench.tone";
import { ProjectEditDialog } from "./ProjectEditDialog";
import { ProjectGlyph } from "./ProjectGlyph";
import { projectAccentHue } from "./ProjectsIndex.model";
import { useProjectWriter } from "./useProjectWriter";
import "./Projects.css";

export function ProjectHomeView({ slug }: { readonly slug: string }): ReactNode {
  const view = useProjectCatalogView();
  const membership = useProjectMembership(view);
  const threads = useThreadShells();
  const writer = useProjectWriter();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

  const project = view.projects.find((entry) => entry.slug === slug) ?? null;

  /**
   * The sky's filter, as a stable identity.
   *
   * `WorkbenchStarMap` memoises on this, so a fresh closure per render would
   * relayout the whole constellation on every keystroke elsewhere in the page.
   */
  const threadKeys = useMemo(
    () => new Set(membership.threadKeysBySlug.get(slug as ProjectCategorySlug) ?? []),
    [membership.threadKeysBySlug, slug],
  );
  const includeThreadKey = useCallback((key: string) => threadKeys.has(key), [threadKeys]);

  const rows = useMemo(
    () =>
      threads
        .filter((thread) => threadKeys.has(`${thread.environmentId}:${thread.id}`))
        .map((thread) => ({
          environmentId: thread.environmentId,
          id: thread.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
          tone: toneForThreadStatus(resolveSidebarV2Status(thread)),
        }))
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [threadKeys, threads],
  );

  if (project === null) {
    return (
      <MissingProject slug={slug} pending={view.notes.some((note) => note.reason === "pending")} />
    );
  }

  const hue = `${projectAccentHue(project.slug)}deg`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header
        className="relative shrink-0 overflow-hidden border-b border-border/60 px-4 py-3"
        style={{ "--sc-project-hue": hue } as never}
      >
        {/* No watermark behind this header. The first pass hung an oversized
            glyph back here; the header is ~80px tall and the mark was 136px, so
            `overflow-hidden` ate it and what survived was invisible at the
            chrome ceiling. An ornament you cannot see is not restraint, it is
            dead CSS — the marker beside the title already says which project
            this is. */}
        <div className="relative z-10 flex flex-wrap items-start gap-3">
          <Link
            to="/projects"
            className="mt-0.5 rounded p-1 text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground"
            aria-label="All projects"
          >
            <ArrowLeftIcon className="size-4" />
          </Link>
          <span className="sc-project-mark mt-px size-7 shrink-0">
            <ProjectGlyph slug={project.slug} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium text-foreground">
              {project.display.title}
            </h1>
            {project.display.summary.length > 0 ? (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                {project.display.summary}
              </p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {project.sections.map((section) => (
                <span
                  key={section.environmentId}
                  className={cn(
                    "rounded border border-border/50 px-1.5 py-px text-[10px] text-muted-foreground/70",
                    section.isLocal && "border-border text-foreground/80",
                  )}
                  title={
                    section.local.bindings.length === 0
                      ? "Knows this project, but no folder bound here"
                      : `${section.local.bindings.length} folder(s) bound here`
                  }
                >
                  {section.label}
                  {section.local.bindings.length === 0 ? " · no folder" : ""}
                </span>
              ))}
              {/* Drift, stated. A machine that missed a rename is not an error
                  — it heals on the next write — but silently showing one title
                  while another machine shows a different one is worse. */}
              {project.staleEnvironmentIds.length > 0 ? (
                <span className="text-[10px] text-muted-foreground/55">
                  {project.staleEnvironmentIds.length} machine
                  {project.staleEnvironmentIds.length === 1 ? "" : "s"} still on an older name
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <PencilIcon className="size-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void writer.setArchived(project.slug, !project.archived).then(() => {
                  if (!project.archived) void navigate({ to: "/projects" });
                });
              }}
            >
              <ArchiveIcon className="size-3.5" />
              {project.archived ? "Unarchive" : "Archive"}
            </Button>
          </div>
        </div>

        {project.display.links.length > 0 ? (
          <div className="relative z-10 mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {project.display.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
              >
                {link.label}
              </a>
            ))}
          </div>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkbenchStarMap
            masterThreadKey={null}
            master={null}
            masterCreatedThreadIds={EMPTY_IDS}
            includeThreadKey={includeThreadKey}
            emptyLabel="Nothing is filed here yet. Bind a folder to this project and its threads appear, or file one from the thread itself."
          />
        </div>

        <aside className="flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-border/60 xl:w-80 xl:border-l xl:border-t-0">
          <header className="flex shrink-0 items-baseline gap-2 border-b border-border/60 px-3 py-2">
            <h2 className="text-xs font-medium text-foreground">Threads</h2>
            <span className="text-[11px] text-muted-foreground/60">{rows.length}</span>
          </header>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <li className="px-3 py-4 text-[11px] text-muted-foreground/60">
                No threads in this project yet.
              </li>
            ) : (
              rows.map((row) => (
                <li key={`${row.environmentId}:${row.id}`}>
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(
                      scopeThreadRef(EnvironmentId.make(row.environmentId), ThreadId.make(row.id)),
                    )}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        WORKBENCH_TONE_DOT_CLASS[row.tone],
                      )}
                      title={WORKBENCH_TONE_LABEL[row.tone]}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {row.title}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </aside>
      </div>

      <ProjectEditDialog
        open={editing}
        onOpenChange={setEditing}
        project={project}
        onSave={(patch) => writer.rename(project.slug, patch)}
      />
    </div>
  );
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * A slug nothing answers for.
 *
 * Two very different situations behind one URL: a project that was removed, and
 * a project whose only machine has not answered yet. Saying "not found" during
 * the second would be a lie that costs an operator a reload.
 */
function MissingProject({
  slug,
  pending,
}: {
  readonly slug: string;
  readonly pending: boolean;
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <p className="text-sm text-muted-foreground/80">
        {pending ? "Looking up…" : "No project called this"}
      </p>
      <p className="max-w-md text-xs text-muted-foreground/55">
        {pending
          ? `Waiting on your machines to say whether they know ${slug}.`
          : `Nothing on your connected machines knows about ${slug}. It may have been removed, or it may only exist on a machine that is offline.`}
      </p>
      <Button size="sm" variant="outline" render={<Link to="/projects" />}>
        All projects
      </Button>
    </div>
  );
}
