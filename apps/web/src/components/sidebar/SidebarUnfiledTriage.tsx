/**
 * Filing threads into projects, from the sidebar's "Unfiled" group.
 *
 * A panel rather than a per-row control, and that is the design decision worth
 * defending. Filing is a two-part question — *which thread* and *which project*
 * — and a hover button on a row can only answer half of it before opening
 * something anyway. It is also the one job you do in a batch: you do not file
 * one thread, you sit down and file the eleven that piled up this week. So the
 * affordance hangs off the group header, where the batch lives, and the rows
 * below stay exactly the rows the inbox renders (F9's minimalism), with no
 * wrapper element between the list and its items.
 *
 * The flow is two steps and no modes: pick a thread, then pick its project. The
 * filed thread leaves the list, and the panel returns to the list for the next
 * one. There is no multi-select, because the whole point of triage is that each
 * thread gets its own decision.
 *
 * A thread is filed on the machine that owns it and nowhere else — a thread id
 * means nothing on any other machine — so this writes to one environment and
 * refreshes that one.
 */
import type { ProjectCategorySlug, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronLeftIcon, FolderInputIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { refreshProjectCatalogs, useFileThreadIntoProject } from "../../state/projectCatalog";
import { ProjectGlyph } from "../projects/ProjectGlyph";
import { projectAccentHue } from "../projects/ProjectsIndex.model";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SidebarProjectGroup } from "../Sidebar.projects";
import "../projects/Projects.css";

export function SidebarUnfiledTriage({
  threads,
  projects,
  environmentLabelById,
}: {
  /** The unfiled threads, in the order the group renders them. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** The live projects a thread can be filed into. */
  readonly projects: ReadonlyArray<SidebarProjectGroup>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<EnvironmentThreadShell | null>(null);
  const fileThread = useFileThreadIntoProject();

  const close = () => {
    setOpen(false);
    setPicked(null);
  };

  const file = (thread: EnvironmentThreadShell, slug: ProjectCategorySlug) => {
    void fileThread({
      environmentId: thread.environmentId,
      request: { mode: "assign", threadId: thread.id as ThreadId, slug },
    }).then(() => refreshProjectCatalogs([thread.environmentId]));
    // Back to the list rather than closing: the reason you opened this is that
    // several threads need filing, and the next one is already on screen.
    setPicked(null);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPicked(null);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="File unfiled threads into a project"
                  data-testid="sidebar-v2-unfiled-triage"
                  className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                />
              }
            >
              <FolderInputIcon aria-hidden className="size-3" />
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom">File into a project</TooltipPopup>
      </Tooltip>

      <PopoverPopup align="start" className="w-64 p-1">
        {picked === null ? (
          <>
            <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
              Pick a thread to file
            </div>
            <ul className="max-h-72 overflow-y-auto">
              {threads.map((thread) => {
                const machine = environmentLabelById.get(thread.environmentId) ?? null;
                return (
                  <li key={`${thread.environmentId}:${thread.id}`}>
                    <button
                      type="button"
                      onClick={() => setPicked(thread)}
                      data-testid="sidebar-v2-unfiled-triage-thread"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {thread.title}
                      </span>
                      {machine === null ? null : (
                        <span className="shrink-0 text-[10px] text-muted-foreground/55">
                          {machine}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <ChevronLeftIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{picked.title}</span>
            </button>
            {projects.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground/70">
                No projects to file into yet.
              </p>
            ) : (
              <ul className="max-h-72 overflow-y-auto border-t border-border/50 pt-1">
                {projects.map((project) => (
                  <li key={project.key}>
                    <button
                      type="button"
                      onClick={() => {
                        if (project.slug !== null) file(picked, project.slug);
                      }}
                      data-testid="sidebar-v2-unfiled-triage-project"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted/50"
                    >
                      <span
                        className={cn("sc-project-mark size-3.5 shrink-0")}
                        style={
                          {
                            "--sc-project-hue": `${projectAccentHue(
                              project.key,
                              project.accent,
                            )}deg`,
                          } as never
                        }
                      >
                        <ProjectGlyph slug={project.key} variant={project.glyph} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {project.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="mt-1 border-t border-border/50 pt-1">
          <button
            type="button"
            onClick={close}
            className="w-full rounded px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            Done
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
