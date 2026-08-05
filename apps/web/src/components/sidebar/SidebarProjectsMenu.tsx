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
 * button, so a list here would be a worse copy of the thing one menu away. The
 * door to a global index went the same way in F16.6, when that page was
 * deleted. What is left is what a strip icon is actually for — the things you
 * cannot do from the list itself.
 *
 * The third entry appears only when there is something to propose. Seeding used
 * to be reachable from the index's header and from the sidebar's empty state,
 * which between them meant: only before you had made your first project. But a
 * proposal is a standing condition — a machine reconnects, a repository is
 * cloned — so it now lives on the one control that is always there, and hides
 * itself when it would be a button with nothing behind it.
 *
 * Note which "project" each action means. "New project" is a *category* — the
 * cross-machine kind, from the catalog. "New folder…" is the server-project the
 * app has always had: a location on this machine. They are different objects
 * and the copy says so, because conflating them is the one confusion this whole
 * feature is built to avoid.
 */
import { useNavigate } from "@tanstack/react-router";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { useProjectCatalogView, useProjectSeedPlan } from "../../state/projectCatalog";
import type { ProjectSeedProposal } from "../projects/ProjectCatalog.model";
import { ProjectCreateDialog } from "../projects/ProjectCreateDialog";
import { ProjectSeedDialog } from "../projects/ProjectSeedDialog";
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
  const [seedOpen, setSeedOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const view = useProjectCatalogView();
  const seedPlan = useProjectSeedPlan(view);
  const writer = useProjectWriter();
  const navigate = useNavigate();

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
          {seedPlan.proposals.length > 0 ? (
            <button
              type="button"
              className={ACTION_CLASS}
              data-testid="sidebar-projects-seed"
              onClick={() => {
                setOpen(false);
                setSeedOpen(true);
              }}
            >
              {/* No trailing hint on this one. The other two need theirs to
                  say which kind of "project" they mean; this label already
                  says what it does, and the hint only pushed it onto a second
                  line. */}
              Set up {seedPlan.proposals.length} from your folders
            </button>
          ) : null}
        </PopoverPopup>
      </Popover>

      <ProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        takenSlugs={takenSlugs}
        onCreate={async (title) => {
          const slug = await writer.create(title);
          // Straight into the new project: creating one is always the first
          // step of doing something with it.
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
    </>
  );
}
