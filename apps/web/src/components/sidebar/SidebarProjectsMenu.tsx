/**
 * The projects popover, hung off the sidebar's icon strip.
 *
 * It replaces the "New project" button rather than joining it. The strip is at
 * seven icons and its own comment admits seven already wraps at the 208px
 * minimum, so an eighth was never available — and "new project" was the weakest
 * of the seven anyway, being one action where this is a way into everything
 * plus that action.
 *
 * Fork-owned and self-contained: it reads its own state and threads one prop,
 * so adding it is an import swap in `SidebarHeaderCompact` and no change at all
 * in `SidebarV2.tsx`.
 *
 * Note which "project" each half of this means. The list is *categories* — the
 * cross-machine kind, from the catalog. "New folder…" at the foot is the
 * server-project the app has always had: a location on this machine. They are
 * different objects and the copy says so, because conflating them is the one
 * confusion this whole feature is built to avoid.
 */
import { Link } from "@tanstack/react-router";
import { FolderPlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import {
  useProjectCards,
  useProjectCatalogView,
  useProjectMembership,
} from "../../state/projectCatalog";
import { ProjectGlyph } from "../projects/ProjectGlyph";
import { projectAccentHue } from "../projects/ProjectsIndex.model";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WORKBENCH_TONE_DOT_CLASS } from "../workbench/Workbench.tone";
import "../projects/Projects.css";

/**
 * Same geometry as the strip's other self-contained buttons. Kept verbatim
 * rather than shared, so the strip's styling stays greppable from any one of
 * its buttons.
 */
const TRIGGER_BUTTON_CLASS =
  "size-7 shrink-0 justify-center rounded-md bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";

/** Long enough to be worth switching to, short enough to stay a menu. */
const VISIBLE_LIMIT = 8;

export function SidebarProjectsMenu({
  onNewProject,
}: {
  /** Creates a server-project — a folder on this machine. */
  readonly onNewProject: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const view = useProjectCatalogView();
  const membership = useProjectMembership(view);
  const cards = useProjectCards(view, membership);

  const live = cards.filter((card) => !card.archived);
  const visible = live.slice(0, VISIBLE_LIMIT);
  const attention = live.reduce((total, card) => total + card.attentionCount, 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  type="button"
                  className={cn(TRIGGER_BUTTON_CLASS, "relative")}
                  aria-label="Projects"
                  data-testid="sidebar-projects"
                />
              }
            >
              <FolderPlusIcon className="size-4" />
              {/* The badge is the reason the icon is in the strip at all: it has
                  to be right *before* the popover is opened. */}
              {attention > 0 ? (
                <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />
              ) : null}
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom">Projects</TooltipPopup>
      </Tooltip>

      <PopoverPopup align="start" className="w-64 p-1">
        <div className="px-2 py-1.5">
          <Link
            to="/projects"
            onClick={() => setOpen(false)}
            className="text-xs font-medium text-foreground hover:underline"
          >
            All projects
          </Link>
        </div>

        {visible.length > 0 ? (
          <ul className="max-h-72 overflow-y-auto">
            {visible.map((card) => (
              <li key={card.slug}>
                <Link
                  to="/projects/$slug"
                  params={{ slug: card.slug }}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50"
                >
                  <span
                    className="sc-project-mark size-3.5 shrink-0"
                    style={{ "--sc-project-hue": `${projectAccentHue(card.slug)}deg` } as never}
                  >
                    <ProjectGlyph slug={card.slug} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {card.title}
                  </span>
                  {card.attentionCount > 0 ? (
                    <span className="shrink-0 text-[10px] text-warning">{card.attentionCount}</span>
                  ) : card.activeCount > 0 ? (
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        WORKBENCH_TONE_DOT_CLASS[card.tone],
                      )}
                    />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 py-2 text-[11px] text-muted-foreground/70">
            No projects yet. Open the projects page to set them up from the repositories your
            machines are already working in.
          </p>
        )}

        {live.length > visible.length ? (
          <p className="px-2 pb-1 text-[10px] text-muted-foreground/55">
            {live.length - visible.length} more on the projects page
          </p>
        ) : null}

        <div className="mt-1 border-t border-border/50 pt-1">
          <button
            type="button"
            className="w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            onClick={() => {
              setOpen(false);
              onNewProject();
            }}
          >
            New folder…
            <span className="ml-1 text-[10px] text-muted-foreground/55">on this machine</span>
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
