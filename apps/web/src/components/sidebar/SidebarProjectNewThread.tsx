/**
 * "New thread in this project", on the project's own header.
 *
 * A thread needs a folder on a machine and a project is neither, so this either
 * knows the answer or asks for it — see `ProjectThreadStart.model.ts` for the
 * ranking. One bound folder is not a question and starts immediately; anything
 * else opens the list, grouped so that the folders this project already claims
 * are visibly separate from the folders it does not.
 *
 * That separation is the whole reason the picker exists rather than a silent
 * best guess. Starting a thread in an unclaimed folder is legal and often right
 * — a hand-made project has no folder until its first thread — but it is also
 * the moment the operator finds out where their work is about to live, and
 * finding that out afterwards, from a worktree in a directory they did not
 * choose, is the bad version.
 */
import type { ProjectCategorySlug } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resolveUnambiguousStartLocation,
  type ProjectStartLocation,
} from "../projects/ProjectThreadStart.model";
import { ConnectionMark } from "./ConnectionMark";

export function SidebarProjectNewThread({
  slug,
  title,
  locations,
  onStart,
}: {
  readonly slug: ProjectCategorySlug;
  readonly title: string;
  /** Already ranked; bound folders first. */
  readonly locations: ReadonlyArray<ProjectStartLocation>;
  readonly onStart: (slug: ProjectCategorySlug, location: ProjectStartLocation) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const unambiguous = resolveUnambiguousStartLocation(locations);
  const bound = locations.filter((location) => location.bound);
  const unbound = locations.filter((location) => !location.bound);

  // Nowhere to put a thread at all: no machine has reported a single folder.
  // The button would open an empty menu, so it does not render.
  if (locations.length === 0) return null;

  const trigger = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`New thread in ${title}`}
            data-testid="sidebar-v2-project-new-thread"
            className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/50 opacity-0 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/project:opacity-100"
            {...(unambiguous === null ? {} : { onClick: () => onStart(slug, unambiguous) })}
          />
        }
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">New thread</TooltipPopup>
    </Tooltip>
  );

  if (unambiguous !== null) return trigger;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup align="start" className="w-64 p-1">
        {bound.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground/70">
            {title} has no folder of its own yet. Pick where this thread should live.
          </p>
        ) : (
          <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            In this project
          </div>
        )}
        <LocationList
          locations={bound}
          onPick={(location) => {
            setOpen(false);
            onStart(slug, location);
          }}
        />
        {unbound.length === 0 ? null : (
          <>
            {bound.length === 0 ? null : (
              <div className="mt-1 border-t border-border/50 px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
                Elsewhere
              </div>
            )}
            <LocationList
              locations={unbound}
              onPick={(location) => {
                setOpen(false);
                onStart(slug, location);
              }}
            />
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function LocationList({
  locations,
  onPick,
}: {
  readonly locations: ReadonlyArray<ProjectStartLocation>;
  readonly onPick: (location: ProjectStartLocation) => void;
}): ReactNode {
  if (locations.length === 0) return null;
  return (
    <ul className="max-h-64 overflow-y-auto">
      {locations.map((location) => (
        <li key={`${location.environmentId}:${location.projectId}`}>
          <button
            type="button"
            onClick={() => onPick(location)}
            data-testid="sidebar-v2-project-new-thread-location"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted/50"
          >
            <ConnectionMark environmentId={location.environmentId} className="size-3" />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {location.title}
            </span>
            {location.isLocalMachine ? null : (
              <span className="shrink-0 text-[10px] text-muted-foreground/55">
                {location.machineLabel}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
