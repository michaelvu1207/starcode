/**
 * "New thread in this project", on the project's own header.
 *
 * A thread needs a folder on a machine and a project is neither, so this either
 * knows the answer or asks for it — see `ProjectThreadStart.model.ts` for which
 * folders are offered. One bound folder is not a question and starts
 * immediately; anything else opens the list.
 *
 * The list only ever starts threads *in this project*, so it does not ask that.
 * It asks which machine, which is the part that is genuinely undecided and the
 * part with consequences — the folder is the thread's cwd, and finding out
 * afterwards, from a worktree on a box you did not choose, is the bad version.
 * So the machine is the visible structure: one group per connection, headed by
 * that machine's own mark and name, with its folders under it.
 */
import type { ProjectCategorySlug } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  flattenProjectStartConnections,
  resolveUnambiguousStartLocation,
  type ProjectStartConnection,
  type ProjectStartLocation,
} from "../projects/ProjectThreadStart.model";
import { ConnectionMark } from "./ConnectionMark";
import { SIDEBAR_PROJECT_ACTION_CLASS } from "./SidebarProjectHeaderActions";

export function SidebarProjectNewThread({
  slug,
  title,
  connections,
  onStart,
}: {
  readonly slug: ProjectCategorySlug;
  readonly title: string;
  /** Already grouped and ranked; this machine's connection first. */
  readonly connections: ReadonlyArray<ProjectStartConnection>;
  readonly onStart: (slug: ProjectCategorySlug, location: ProjectStartLocation) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const unambiguous = resolveUnambiguousStartLocation(connections);
  // Nowhere to put a thread at all: no machine has reported a single folder.
  // The button would open an empty menu, so it does not render.
  if (connections.length === 0) return null;

  const BUTTON_CLASS = SIDEBAR_PROJECT_ACTION_CLASS;

  // One bound folder is not a choice: click and go, no menu in the way.
  if (unambiguous !== null) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`New thread in ${title}`}
              data-testid="sidebar-v2-project-new-thread"
              className={BUTTON_CLASS}
              onClick={(event) => {
                event.stopPropagation();
                onStart(slug, unambiguous);
              }}
            />
          }
        >
          <PlusIcon aria-hidden className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New thread</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* ⚠️ The nesting order is load-bearing and the wrong one is silent.
          `PopoverTrigger render={<Tooltip>…}` type-checks, renders a button
          that looks right, and does NOTHING: the popover's props are spread
          onto `Tooltip`, which is a context-only Root with no DOM to put them
          on, so no click handler ever reaches the button. The trigger has to be
          the innermost wrapper around the real element — same shape as
          `SidebarConnectionsMenu` and `SidebarUnfiledTriage`. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`New thread in ${title}`}
                  data-testid="sidebar-v2-project-new-thread"
                  className={BUTTON_CLASS}
                />
              }
            />
          }
        >
          <PlusIcon aria-hidden className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New thread</TooltipPopup>
      </Tooltip>
      {/* The popup is portaled, but React events travel the React tree, so a
          click in here still reaches the project header the trigger sits in.
          Every handler below stops it. */}
      <PopoverPopup align="start" className="w-72 p-1" onClick={(event) => event.stopPropagation()}>
        <ProjectStartPicker
          title={title}
          connections={connections}
          onPick={(location) => {
            setOpen(false);
            onStart(slug, location);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The popup's own contents, separated from the popup.
 *
 * Not a layering preference: a closed base UI popup renders no markup at all,
 * and this suite renders to static markup, so a list that only exists inside
 * `PopoverPopup` is a list no test can look at. Everything the operator reads
 * lives here, where it can be asserted directly.
 */
export function ProjectStartPicker({
  title,
  connections,
  onPick,
}: {
  readonly title: string;
  readonly connections: ReadonlyArray<ProjectStartConnection>;
  readonly onPick: (location: ProjectStartLocation) => void;
}): ReactNode {
  const claimed = flattenProjectStartConnections(connections).some((location) => location.bound);
  return (
    <>
      <p
        data-testid="sidebar-v2-project-new-thread-heading"
        className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground"
      >
        {`New thread in ${title}, on which machine?`}
      </p>
      {connections.map((connection) => (
        <ConnectionGroup key={connection.environmentId} connection={connection} onPick={onPick} />
      ))}
      {/* Why one folder per machine here and every folder when there are
          bindings: this project has claimed none, so these are guesses, and a
          guess per machine is the honest amount to show. */}
      {claimed ? null : (
        <p
          data-testid="sidebar-v2-project-new-thread-note"
          className="mt-1 border-t border-border/50 px-2 pb-0.5 pt-1.5 text-[11px] text-muted-foreground/70"
        >
          {`${title} has no folder of its own yet — bind one to change these.`}
        </p>
      )}
    </>
  );
}

function ConnectionGroup({
  connection,
  onPick,
}: {
  readonly connection: ProjectStartConnection;
  readonly onPick: (location: ProjectStartLocation) => void;
}): ReactNode {
  return (
    <div className="mt-0.5 first:mt-0">
      <div
        data-testid="sidebar-v2-project-new-thread-connection"
        data-environment-id={connection.environmentId}
        className="flex items-center gap-1.5 px-2 pb-0.5 pt-1"
      >
        <ConnectionMark environmentId={connection.environmentId} className="size-3" />
        <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
          {connection.machineLabel}
        </span>
      </div>
      <ul className="max-h-64 overflow-y-auto">
        {connection.locations.map((location) => (
          <li key={`${location.environmentId}:${location.projectId}`}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPick(location);
              }}
              data-testid="sidebar-v2-project-new-thread-location"
              className="flex w-full items-center gap-2 rounded py-1.5 pl-[1.625rem] pr-2 text-left hover:bg-muted/50"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {location.title}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
