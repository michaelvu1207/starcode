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
import type { SnoozePreset } from "../Sidebar.snooze";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  ClockIcon,
  Undo2Icon,
} from "lucide-react";
import {
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
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
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Controlled by the caller, which also uses the open state to pin the hover
 * actions while the menu is up.
 */
function SnoozePopoverButton({
  open,
  onOpenChange,
  onSnooze,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSnooze: (preset: SnoozePreset) => void;
}): ReactNode {
  // Presets resolve at open time so "In 1 hour" is relative to the click, not
  // to when the row mounted.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Snooze thread"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex h-full cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ClockIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-56" viewportClassName="p-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onSnooze(preset);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
              {preset.whenLabel}
            </span>
          </button>
        ))}
      </PopoverPopup>
    </Popover>
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
  readonly snoozeMenuOpen: boolean;
}

export interface SidebarThreadRowActions {
  readonly onClick: (event: ReactMouseEvent) => void;
  readonly onDoubleClick: (event: ReactMouseEvent) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  readonly onRenameChange: (title: string) => void;
  readonly onRenameKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onRenameBlur: () => void;
  readonly onSettle: (event: ReactMouseEvent) => void;
  readonly onUnsettle: (event: ReactMouseEvent) => void;
  readonly onUnsnooze: (event: ReactMouseEvent) => void;
  readonly onSnooze: (preset: SnoozePreset) => void;
  readonly onSnoozeMenuOpenChange: (open: boolean) => void;
}

export function SidebarThreadRow({
  thread,
  status,
  flags,
  actions,
  timeLabel,
  snoozeWakeLabelText,
  rowAction,
  settlementSupported,
  snoozeSupported,
  showSnoozeButton,
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
  /** What the hover button on this row does. */
  readonly rowAction: "settle" | "unsettle" | "unsnooze";
  /** False where the server predates thread.settle: the button hides. */
  readonly settlementSupported: boolean;
  /** Same contract for thread.snooze/unsnooze — gates the wake button. */
  readonly snoozeSupported: boolean;
  /** Snooze is also refused on blocked or queued work, so it has its own gate. */
  readonly showSnoozeButton: boolean;
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

          {/* One trailing block: status, machine, agent, time. It fades as a
              unit on hover and the row's actions take its place — the actions
              need more width than the time label alone occupies, and sliding
              the icons sideways to make room would make the right edge of the
              list twitch under the pointer. */}
          <span className="relative flex h-6 shrink-0 items-center justify-end">
            <span
              className={cn(
                "flex items-center gap-2 transition-opacity group-hover/v2-row:opacity-0",
                flags.snoozeMenuOpen && "opacity-0",
              )}
            >
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
              <span
                className={cn(
                  "min-w-7 text-right text-xs tabular-nums text-muted-foreground/55",
                  rowAction === "unsnooze" &&
                    snoozeWakeLabelText !== null &&
                    "text-blue-600 dark:text-blue-400",
                )}
              >
                {trailingLabel}
              </span>
            </span>
            <span
              className={cn(
                "absolute inset-y-0 right-0 flex items-stretch gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100",
                flags.snoozeMenuOpen && "opacity-100",
              )}
            >
              {rowAction === "unsnooze" ? (
                // A snoozed row offers exactly one thing: come back now.
                snoozeSupported ? (
                  <button
                    type="button"
                    aria-label="Wake thread now"
                    onClick={actions.onUnsnooze}
                    className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground hover:text-foreground"
                  >
                    <AlarmClockOffIcon className="size-3" />
                  </button>
                ) : null
              ) : (
                <>
                  {showSnoozeButton ? (
                    <SnoozePopoverButton
                      open={flags.snoozeMenuOpen}
                      onOpenChange={actions.onSnoozeMenuOpenChange}
                      onSnooze={actions.onSnooze}
                    />
                  ) : null}
                  {settlementSupported ? (
                    <button
                      type="button"
                      aria-label={rowAction === "unsettle" ? "Un-settle thread" : "Settle thread"}
                      onClick={rowAction === "unsettle" ? actions.onUnsettle : actions.onSettle}
                      className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground hover:text-foreground"
                    >
                      {rowAction === "unsettle" ? (
                        <Undo2Icon className="size-3" />
                      ) : (
                        <CheckIcon className="size-3" />
                      )}
                    </button>
                  ) : null}
                </>
              )}
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
