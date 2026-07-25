/**
 * The projects popover, hung off the sidebar's icon strip.
 *
 * It replaces the "New project" button rather than joining it. The strip is at
 * seven icons and its own comment admits seven already wraps at the 208px
 * minimum, so an eighth was never available — and "new project" was the weakest
 * of the seven anyway, being one action where this is two plus a door.
 *
 * This used to also list the projects and link to each one. It does not any
 * more: projects are a sidebar VIEW now (`SidebarProjectsView`), which shows
 * every project with its threads under it rather than eight names behind a
 * button, so a list here would be a worse copy of the thing one menu away. What
 * is left is what a strip icon is actually for — the two things you cannot do
 * from the list itself, plus the door to the index page the list has no room
 * for.
 *
 * Note which "project" each action means. "New project" is a *category* — the
 * cross-machine kind, from the catalog. "New folder…" is the server-project the
 * app has always had: a location on this machine. They are different objects
 * and the copy says so, because conflating them is the one confusion this whole
 * feature is built to avoid.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderPlusIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useProjectCatalogView } from "../../state/projectCatalog";
import { ProjectCreateDialog } from "../projects/ProjectCreateDialog";
import { useProjectWriter } from "../projects/useProjectWriter";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Same geometry as the strip's other self-contained buttons. Kept verbatim
 * rather than shared, so the strip's styling stays greppable from any one of
 * its buttons.
 */
const TRIGGER_BUTTON_CLASS =
  "size-7 shrink-0 justify-center rounded-md bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";

const ACTION_CLASS =
  "w-full rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50";

export function SidebarProjectsMenu({
  onNewProject,
}: {
  /** Creates a server-project — a folder on this machine. */
  readonly onNewProject: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const view = useProjectCatalogView();
  const writer = useProjectWriter();
  const navigate = useNavigate();

  const takenSlugs = useMemo(
    () => new Set(view.projects.map((project) => project.slug)),
    [view.projects],
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    type="button"
                    className={TRIGGER_BUTTON_CLASS}
                    aria-label="Projects"
                    data-testid="sidebar-projects"
                  />
                }
              >
                <FolderPlusIcon className="size-4" />
              </PopoverTrigger>
            }
          />
          <TooltipPopup side="bottom">Projects</TooltipPopup>
        </Tooltip>

        <PopoverPopup align="start" className="w-64 p-1">
          <button
            type="button"
            className={ACTION_CLASS}
            data-testid="sidebar-projects-new-category"
            onClick={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
          >
            New project
            <span className="ml-1 text-[10px] text-muted-foreground/55">across your machines</span>
          </button>
          <button
            type="button"
            className={ACTION_CLASS}
            data-testid="sidebar-projects-new-folder"
            onClick={() => {
              setOpen(false);
              onNewProject();
            }}
          >
            New folder…
            <span className="ml-1 text-[10px] text-muted-foreground/55">on this machine</span>
          </button>
          <div className="mt-1 border-t border-border/50 pt-1">
            <Link
              to="/projects"
              onClick={() => setOpen(false)}
              className="block rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              All projects
            </Link>
          </div>
        </PopoverPopup>
      </Popover>

      <ProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        takenSlugs={takenSlugs}
        onCreate={async (title) => {
          const slug = await writer.create(title);
          // Straight into the new project, the same way the index does it:
          // creating one is always the first step of doing something with it.
          if (slug !== null) void navigate({ to: "/projects/$slug", params: { slug } });
        }}
      />
    </>
  );
}
