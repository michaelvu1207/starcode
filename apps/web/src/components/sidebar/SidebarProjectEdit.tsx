/**
 * "Edit project", on the project's own heading in the sidebar.
 *
 * The same dialog the project home opens, from the surface an operator actually
 * lives in. Michael: *"I should be able to edit, rename a project, change the
 * icon, stuff like that."* — and the sidebar is where a project's name is read
 * forty times a day, so it is where the wish to change it occurs. Sending that
 * wish through `/projects/$slug` first is a navigation the edit does not need.
 *
 * A pencil rather than a `···` menu: there is exactly one thing behind it, and a
 * menu whose only entry is "Edit" costs a click to say so. It matches the pencil
 * on the project home header, which is the point — the same mark opening the
 * same dialog from both places is what makes them feel like one affordance
 * rather than two features.
 *
 * Delete is deliberately absent, for the reason the project home already states:
 * the heading is a target you hit constantly, and the one action that cannot be
 * undone does not belong on it.
 */
import type { ProjectCategoryDisplayPatch } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ProjectCategoryView } from "../projects/ProjectCatalog.model";
import { ProjectEditDialog } from "../projects/ProjectEditDialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_PROJECT_ACTION_CLASS } from "./SidebarProjectHeaderActions";

export function SidebarProjectEdit({
  project,
  onSave,
}: {
  readonly project: ProjectCategoryView;
  readonly onSave: (patch: ProjectCategoryDisplayPatch) => Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip>
        {/* The trigger has to be the innermost wrapper around the real element,
            the same rule `SidebarProjectNewThread` documents: a tooltip is a
            context-only Root, so spreading a trigger's props onto it produces a
            button that looks right and does nothing. Nothing is spread onto the
            tooltip here — the button is the child — but the ordering is kept
            identical so the two headings' controls stay one pattern. */}
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Edit ${project.display.title}`}
              data-testid="sidebar-v2-project-edit"
              className={SIDEBAR_PROJECT_ACTION_CLASS}
              onClick={(event) => {
                // The heading is a toggle and this button sits inside it. Without
                // this, editing a project also collapses it.
                event.stopPropagation();
                setOpen(true);
              }}
            />
          }
        >
          <PencilIcon aria-hidden className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Edit project</TooltipPopup>
      </Tooltip>

      {/* Portaled, but React events travel the React tree, so a click inside the
          dialog still arrives at the heading this button sits in — where it
          would read as "collapse the project". Stopped at the boundary. */}
      <div onClick={(event) => event.stopPropagation()}>
        <ProjectEditDialog open={open} onOpenChange={setOpen} project={project} onSave={onSave} />
      </div>
    </>
  );
}
