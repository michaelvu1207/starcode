/**
 * The sidebar thread row. One row, one shape, every view.
 *
 * There used to be two: an elevated three-line card for live threads and a
 * one-line slim row for settled and snoozed ones. That is two layouts for one
 * object, so the same thread changed size and lost half its detail the moment
 * it settled, and a list containing both read as two lists stapled together.
 * The card also spent 78px and three lines saying what fits on one.
 *
 * What is on the row, and nothing else: the thread's name, the machine it runs
 * on, the agent driving it, and when it last spoke. Status is a coloured glyph
 * in front of the time, and how far through its task list the thread is is a
 * hairline along the bottom edge. Everything the card used to spell out —
 * project name, machine name, model, branch, task counts, the failure — is in
 * the tooltip, which is where second-order detail belongs on a surface you
 * scan forty times a day.
 *
 * Three things are deliberately absent. There is no rounded card: the hover and
 * selection surfaces are full-bleed bands, so a list of threads reads as a list
 * and not as a stack of tiles. There is no ticking work duration; the working
 * glyph pulses, which answers "is it running" without a second of layout
 * churn per second. And there is no machine *name* — the mark carries the
 * machine's identity in colour, and the name is one hover away.
 *
 * Fork-owned and purely presentational. Every piece of state and every handler
 * arrives as a prop from `SidebarV2Row`, which keeps the hooks, the git and PR
 * lookups, and the rename plumbing where upstream put them — so the permanent
 * diff in `SidebarV2.tsx` is the JSX this file replaced and nothing more.
 */
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarV2Status } from "../Sidebar.logic";
import {
  AlarmClockIcon,
  ArchiveIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { ConnectionMark } from "./ConnectionMark";
import { ThreadTaskProgress } from "./ThreadTaskProgress";
import { hasThreadTaskProgress } from "./ThreadTaskProgress.logic";
import { resolveThreadRowStatusChip, type ThreadRowStatusTone } from "./SidebarThreadRow.status";

/**
 * Status hues follow the convention sidebar v1 and the mobile Live Activity
 * set, so a thread reads the same colour everywhere it surfaces.
 */
const STATUS_TONE_CLASS: Readonly<Record<ThreadRowStatusTone, string>> = {
  working: "animate-status-pulse text-sky-600 motion-reduce:animate-none dark:text-sky-400",
  approval: "text-amber-700 dark:text-amber-300",
  input: "text-indigo-600 dark:text-indigo-300",
  failed: "text-red-700 dark:text-red-300",
  woke: "text-amber-700 dark:text-amber-300",
  done: "text-emerald-700 dark:text-emerald-300",
};

function StatusGlyph({ tone }: { readonly tone: ThreadRowStatusTone }): ReactNode {
  const className = "size-3.5 shrink-0";
  switch (tone) {
    case "working":
      return <CircleDashedIcon aria-hidden className={className} />;
    case "approval":
      return <CircleDotIcon aria-hidden className={className} />;
    case "input":
      return <CircleDotIcon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "woke":
      return <AlarmClockIcon aria-hidden className={className} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={className} />;
  }
}

/**
 * Floats at the row's right edge while the jump modifier is held. An overlay
 * rather than an inline slot: the hint must not displace the time label or
 * shift any layout when it appears, and `pointer-events-none` keeps it from
 * swallowing clicks meant for the hover actions it can cover.
 */
function JumpHintBadge({ label }: { readonly label: string }): ReactNode {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
    >
      {label}
    </span>
  );
}

/**
 * The one verb that lives on the row.
 *
 * There used to be a `···` here opening a menu of eight, which is the shape you
 * reach for when a row has many verbs and nowhere to put them. It had a real
 * cost: every entry in it was two clicks away, and the row already has a menu —
 * right-click, which is where the same list now lives in full, including the
 * entries the popup never had.
 *
 * What stays behind is the verb you actually reach for while skimming, and the
 * only one worth the width: archive. Same slot the `···` used, so nothing about
 * the row's geometry changed — the time steps aside on hover and this takes its
 * place. Archiving is instant, with an Undo on the toast; a confirm dialog for
 * a reversible action you take dozens of times a session is a dialog you learn
 * to dismiss without reading.
 *
 * `stopPropagation` is load-bearing, not defensive: the whole row is a click
 * target that navigates, so without it archiving also opens the thread it just
 * took off the list.
 */
function ArchiveRowButton({ onArchive }: { readonly onArchive: () => void }): ReactNode {
  return (
    <button
      type="button"
      aria-label="Archive thread"
      title="Archive thread"
      data-testid="sidebar-v2-row-archive"
      onClick={(event) => {
        event.stopPropagation();
        onArchive();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className="inline-flex h-full cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground hover:text-foreground"
    >
      <ArchiveIcon aria-hidden className="size-3.5" />
    </button>
  );
}

export interface SidebarThreadRowFlags {
  readonly isActive: boolean;
  readonly isSelected: boolean;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  /** Read, quiet, or merely in flight: recedes so the list's loud rows lead. */
  readonly shouldRecede: boolean;
  readonly isRenaming: boolean;
}

export interface SidebarThreadRowActions {
  readonly onClick: (event: ReactMouseEvent) => void;
  readonly onDoubleClick: (event: ReactMouseEvent) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  readonly onRenameChange: (title: string) => void;
  readonly onRenameKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onRenameBlur: () => void;
  /** Puts the row into its rename input. Double-click and the menu share it. */
  readonly onStartRename: () => void;
  /** The hover button. Every other verb is on the row's context menu. */
  readonly onArchive: () => void;
}

export function SidebarThreadRow({
  thread,
  status,
  flags,
  actions,
  timeLabel,
  snoozeWakeLabelText,
  rowAction,
  driverKind,
  providerDisplayName,
  jumpLabel,
  renamingTitle,
  tooltip,
}: {
  readonly thread: SidebarThreadSummary;
  readonly status: SidebarV2Status;
  readonly flags: SidebarThreadRowFlags;
  readonly actions: SidebarThreadRowActions;
  /** When the thread last spoke, already compacted ("4h", "now"). */
  readonly timeLabel: string;
  /** Compact wake countdown ("2h") for rows on the snooze shelf. */
  readonly snoozeWakeLabelText: string | null;
  /** Which section this row is in; only picks which timestamp it reads as. */
  readonly rowAction: "settle" | "unsettle" | "unsnooze";
  readonly driverKind: ProviderInstanceEntry["driverKind"] | null;
  readonly providerDisplayName: string;
  readonly jumpLabel: string | null;
  readonly renamingTitle: string;
  readonly tooltip: ReactNode;
}): ReactNode {
  const chip = resolveThreadRowStatusChip({
    status,
    isUnread: flags.isUnread,
    isWoke: flags.isWoke,
  });
  const hasProgress = hasThreadTaskProgress(thread.planSummary);
  // A snoozed row shows when it comes BACK rather than when it was last
  // touched: the return ticket is that row's whole story.
  const trailingLabel =
    rowAction === "unsnooze" && snoozeWakeLabelText !== null ? snoozeWakeLabelText : timeLabel;

  return (
    <li
      data-thread-item
      className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_32px]"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              data-testid="sidebar-v2-row"
              data-status={status}
              // Square, full-bleed, flush against its neighbours. Rounding and
              // a vertical gap would draw a card around every thread, which is
              // the thing this row exists to stop doing.
              className={cn(
                "group/v2-row relative flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden px-2.5 text-left outline-none select-none",
                flags.isActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : flags.isSelected
                    ? "bg-sidebar-row-selected text-sidebar-foreground"
                    : flags.shouldRecede
                      ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
              )}
              onClick={actions.onClick}
              onDoubleClick={actions.onDoubleClick}
              onKeyDown={actions.onKeyDown}
              onContextMenu={actions.onContextMenu}
            />
          }
        >
          {flags.isRenaming ? (
            <input
              autoFocus
              value={renamingTitle}
              aria-label="Thread title"
              onChange={(event) => actions.onRenameChange(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={actions.onRenameKeyDown}
              onBlur={actions.onRenameBlur}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm text-card-foreground outline-none focus:border-foreground"
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm group-hover/v2-row:text-foreground",
                flags.shouldRecede ? "font-normal" : "font-medium",
                flags.isActive || flags.isWoke
                  ? "text-foreground"
                  : flags.shouldRecede
                    ? "text-muted-foreground/75"
                    : "text-foreground/90",
              )}
            >
              {thread.title}
            </span>
          )}

          {/* The trailing block holds still. Status, machine and agent are
              fixed-width and never move, so nothing about the row changes shape
              when the pointer crosses it — the thing that made a list of these
              unreadable to skim. Only the time slot swaps, and only for the
              archive button: the time is the least load-bearing thing on the
              row, and the alternative is a button sitting permanently on every
              row. */}
          <span className="flex h-6 shrink-0 items-center justify-end gap-2">
            {chip === null ? null : (
              <span
                role="status"
                aria-label={chip.label}
                title={chip.label}
                data-testid="sidebar-v2-row-status"
                data-tone={chip.tone}
                className={cn("inline-flex shrink-0 items-center", STATUS_TONE_CLASS[chip.tone])}
              >
                <StatusGlyph tone={chip.tone} />
              </span>
            )}
            <ConnectionMark environmentId={thread.environmentId} className="size-3.5" />
            {driverKind === null ? null : (
              <span
                data-testid="sidebar-v2-row-provider"
                data-driver-kind={driverKind}
                className="inline-flex shrink-0 items-center opacity-70"
              >
                <ProviderInstanceIcon
                  driverKind={driverKind}
                  displayName={providerDisplayName}
                  iconClassName="size-3.5"
                />
              </span>
            )}
            <span className="relative flex h-6 min-w-7 shrink-0 items-center justify-end">
              {/* The time always makes way: archive is on every row, on every
                  machine, and asks the server nothing, so there is no row whose
                  hover slot would come up empty. */}
              <span
                className={cn(
                  "text-xs tabular-nums transition-opacity text-muted-foreground/55 group-hover/v2-row:opacity-0",
                  rowAction === "unsnooze" &&
                    snoozeWakeLabelText !== null &&
                    "text-blue-600 dark:text-blue-400",
                )}
              >
                {trailingLabel}
              </span>
              {/* Focus-reachable, not hover-only: the row is tabbable and this
                  is the next stop after it, so archive is reachable from the
                  keyboard without a pointer ever touching the row. */}
              <span className="absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100">
                <ArchiveRowButton onArchive={actions.onArchive} />
              </span>
            </span>
          </span>

          {/* The task list, as a hairline along the bottom edge rather than a
              line of its own. It is the one thing on the row that changes while
              you watch, and giving it the full width costs no height and no
              character of the title. The counts and the current step are in the
              tooltip. */}
          {hasProgress ? (
            <span className="pointer-events-none absolute inset-x-2.5 bottom-0.5 flex">
              <ThreadTaskProgress summary={thread.planSummary} />
            </span>
          ) : null}

          {jumpLabel === null ? null : <JumpHintBadge label={jumpLabel} />}
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
    </li>
  );
}
