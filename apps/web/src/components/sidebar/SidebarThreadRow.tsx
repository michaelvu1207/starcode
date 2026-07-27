/**
 * The sidebar thread row. One row, one shape, every view.
 *
 * There used to be two: an elevated three-line card for live threads and a
 * one-line slim row for settled and snoozed ones. That is two layouts for one
 * object, so the same thread changed size and lost half its detail the moment
 * it settled, and a list containing both read as two lists stapled together.
 * The card also spent 78px and three lines saying what fits on one.
 *
 * What is on the row, and nothing else: the machine it runs on, the thread's
 * name, and when it last spoke — the machine's mark leading the row, the title
 * taking the space that is left. Status is a coloured glyph in front of the
 * time, and how far through its task list the thread is is a hairline along the
 * bottom edge. Everything the card used to spell out — project name, machine
 * name, model, branch, task counts, the failure — is in the tooltip, which is
 * where second-order detail belongs on a surface you scan forty times a day.
 *
 * Four things are deliberately absent. There is no rounded card: the hover and
 * selection surfaces are full-bleed bands, so a list of threads reads as a list
 * and not as a stack of tiles. There is no ticking work duration; the working
 * glyph pulses, which answers "is it running" without a second of layout
 * churn per second. There is no machine *name* — the mark carries the machine's
 * identity in colour, and the name is one hover away. And there is no agent
 * glyph: which of Claude or Codex is driving is not how you pick a thread out
 * of a list, and it is named beside its model in the tooltip.
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
  Columns2Icon,
  EllipsisIcon,
  Undo2Icon,
} from "lucide-react";
import {
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import type { OpenInSplitState } from "../split/openInSplit";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { ConnectionMark } from "./ConnectionMark";
import { ThreadRowArchiveAction, ThreadRowFilingActions } from "./SidebarThreadRowActions";
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
 * What the split entry reads as, per state. The two disabled labels name the
 * pane the thread is already in rather than saying a flat "unavailable": on the
 * row you are reading, "here" is the answer to why the entry is grey.
 */
const SPLIT_MENU_LABEL: Readonly<Record<Exclude<OpenInSplitState, "hidden">, string>> = {
  ready: "Open in split view",
  "already-primary": "Already open here",
  "already-secondary": "Already in split view",
};

/**
 * Everything you can do to a row, behind one button.
 *
 * The row used to swap its own content on hover: the machine, the agent and
 * the time faded out and a strip of icon buttons faded in over them. Four
 * things moved every time the pointer crossed a row, which in a list you skim
 * is most of the time, and none of the four was what you were looking at.
 *
 * Now the row holds still and a single `···` appears in the time's place — the
 * one swap worth making, because the time is the least load-bearing thing on
 * the row and the alternative is either a permanently visible button on every
 * row or no room for one at all.
 *
 * The presets are menu items rather than a nested popover. Snooze used to be
 * its own button opening its own surface, which meant two clicks and two
 * dismiss targets for something that is one decision; a labelled group in the
 * menu that is already open costs neither.
 *
 * Four blocks, separated, in the order you reach for them: open it beside what
 * you are reading; edit it (rename, file, fork); park it (settle, snooze);
 * archive it. Archive is last and alone because it is the only entry that takes
 * the thread off the list, and the snooze presets are the thing directly above
 * it that a fast hand is aiming for.
 *
 * `stopPropagation` on the trigger is not defensive: the whole row is a click
 * target that navigates, so without it opening the menu also opens the thread.
 */
function ThreadRowMenu({
  open,
  onOpenChange,
  thread,
  driverKind,
  rowAction,
  settlementSupported,
  snoozeAllowed,
  snoozeSupported,
  splitState,
  onOpenInSplit,
  onRename,
  onSettle,
  onUnsettle,
  onUnsnooze,
  onSnooze,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The thread the verbs below act on; they resolve their own state from it. */
  readonly thread: SidebarThreadSummary;
  /** Which agent drives it. Only some can fork a session — see the fork entry. */
  readonly driverKind: ProviderInstanceEntry["driverKind"] | null;
  readonly rowAction: "settle" | "unsettle" | "unsnooze";
  readonly settlementSupported: boolean;
  readonly snoozeAllowed: boolean;
  readonly snoozeSupported: boolean;
  /** Whether this thread can go in the right pane — see `openInSplit`. */
  readonly splitState: OpenInSplitState;
  readonly onOpenInSplit: () => void;
  readonly onRename: () => void;
  readonly onSettle: (event: ReactMouseEvent) => void;
  readonly onUnsettle: (event: ReactMouseEvent) => void;
  readonly onUnsnooze: (event: ReactMouseEvent) => void;
  readonly onSnooze: (preset: SnoozePreset) => void;
}): ReactNode {
  // Resolved at open time so "In 1 hour" is an hour from the click rather than
  // from whenever this row mounted.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  // Whether the lifecycle block has anything in it. Its entries are the only
  // ones in this menu the server can refuse to support, so it is the only block
  // whose separator has to be conditional.
  const hasLifecycleEntries =
    rowAction === "unsnooze" ? snoozeSupported : settlementSupported || snoozeAllowed;

  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Thread actions"
            data-testid="sidebar-v2-row-menu"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex h-full cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <EllipsisIcon aria-hidden className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        {/* First, and above the separator: this is the only entry that opens
            something rather than filing it away, and it is how the split is
            reached at all. The thread stays where the pointer is — the one you
            are reading keeps the left pane and this one fills the right. */}
        {splitState === "hidden" ? null : (
          <>
            {/* `stopPropagation` is load-bearing, not defensive. The popup is
                portalled to the body, but a React portal's events bubble up the
                *component* tree, so this click reaches the row — and the row
                navigates. Without it, opening a thread on the right also drags
                the left pane onto it, which is the one thing this entry exists
                not to do. The settle and wake handlers stop it for the same
                reason; the snooze presets take no event and need none. */}
            <MenuItem
              closeOnClick
              disabled={splitState !== "ready"}
              onClick={(event) => {
                event.stopPropagation();
                if (splitState === "ready") onOpenInSplit();
              }}
              className="sm:text-xs"
            >
              <Columns2Icon aria-hidden className="size-3.5" />
              {SPLIT_MENU_LABEL[splitState]}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {/* What you do TO the thread, above what you do WITH its lifecycle:
            renaming, filing and forking are edits to the thread itself, and
            they are the ones that ask nothing of the server, so they are the
            block that is always here. Mounted only while the popup is open —
            they carry their own hooks, and the row is rendered hundreds of
            times. */}
        {open ? (
          <ThreadRowFilingActions thread={thread} driverKind={driverKind} onRename={onRename} />
        ) : null}
        {hasLifecycleEntries ? <MenuSeparator /> : null}
        {rowAction === "unsnooze" ? (
          snoozeSupported ? (
            <MenuItem closeOnClick onClick={onUnsnooze} className="sm:text-xs">
              <AlarmClockOffIcon aria-hidden className="size-3.5" />
              Wake now
            </MenuItem>
          ) : null
        ) : (
          <>
            {settlementSupported ? (
              <MenuItem
                closeOnClick
                onClick={rowAction === "unsettle" ? onUnsettle : onSettle}
                className="sm:text-xs"
              >
                {rowAction === "unsettle" ? (
                  <Undo2Icon aria-hidden className="size-3.5" />
                ) : (
                  <CheckIcon aria-hidden className="size-3.5" />
                )}
                {rowAction === "unsettle" ? "Un-settle" : "Settle"}
              </MenuItem>
            ) : null}
            {snoozeAllowed ? (
              <>
                {settlementSupported ? <MenuSeparator /> : null}
                <MenuGroup>
                  <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">
                    Snooze
                  </div>
                  {presets.map((preset) => (
                    <MenuItem
                      key={preset.id}
                      closeOnClick
                      onClick={() => onSnooze(preset)}
                      className="sm:text-xs"
                    >
                      <span className="flex-1">{preset.label}</span>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
                        {preset.whenLabel}
                      </span>
                    </MenuItem>
                  ))}
                </MenuGroup>
              </>
            ) : null}
          </>
        )}
        {/* Alone below the last separator: archive is the only entry here that
            takes the thread off the list, and the one you must not reach for by
            accident on the way to Snooze. */}
        <MenuSeparator />
        {open ? <ThreadRowArchiveAction thread={thread} /> : null}
      </MenuPopup>
    </Menu>
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
  readonly onSettle: (event: ReactMouseEvent) => void;
  readonly onUnsettle: (event: ReactMouseEvent) => void;
  readonly onUnsnooze: (event: ReactMouseEvent) => void;
  readonly onSnooze: (preset: SnoozePreset) => void;
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
  snoozeAllowed,
  splitState,
  driverKind,
  jumpLabel,
  renamingTitle,
  tooltip,
  onOpenInSplit,
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
  readonly snoozeAllowed: boolean;
  /**
   * Whether this thread can go in the right pane, and if not, why. A property
   * of the window and of what is already on screen rather than of the thread —
   * resolved by `useOpenInSplitState` in `SidebarV2Row` and handed down, like
   * every other decision this row makes.
   */
  readonly splitState: OpenInSplitState;
  /**
   * Which agent drives the thread. No longer drawn on the row — it reaches only
   * the menu, where it decides whether the session can be forked.
   */
  readonly driverKind: ProviderInstanceEntry["driverKind"] | null;
  readonly jumpLabel: string | null;
  readonly renamingTitle: string;
  readonly tooltip: ReactNode;
  readonly onOpenInSplit: () => void;
}): ReactNode {
  const chip = resolveThreadRowStatusChip({
    status,
    isUnread: flags.isUnread,
    isWoke: flags.isWoke,
  });
  // Owned here rather than by the caller: which menu is open is presentation,
  // and keeping it in the row is what lets the `···` stay pinned while the
  // pointer is off in the menu.
  const [menuOpen, setMenuOpen] = useState(false);
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
          {/* The machine leads the row. It is the one thing here that says where
              the work is happening, and a column of marks down the left edge is
              scannable in a way the same glyph buried in the trailing block was
              not — you find a machine's threads by running down one edge rather
              than reading four rows' worth of right-hand furniture.
              Outside the rename branch so it holds its place while the title is
              an input: the row must not reflow to be edited. */}
          <ConnectionMark environmentId={thread.environmentId} className="size-3.5" />

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

          {/* The trailing block holds still. Status is fixed-width and never
              moves, so nothing about the row changes shape when the pointer
              crosses it — the thing that made a list of these unreadable to
              skim. Only the time slot swaps, and only for the menu: it is the
              least load-bearing thing on the row, and the alternative is a `···`
              sitting permanently on every row.
              The agent's glyph used to sit here, beside the machine's. Two
              decorative marks in the corner of a row you skim is one more than
              carries its weight, and of the two the agent is the one you rarely
              choose a thread by — it is named, with its model, in the tooltip.
              The machine kept its place in the list and moved to the left edge. */}
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
            <span className="relative flex h-6 min-w-7 shrink-0 items-center justify-end">
              {/* The time always makes way now. It used to hold its place on
                  rows whose menu would have been empty — a real case when the
                  only entries were capability-gated — but rename, move, fork
                  and archive ask the server for nothing, so every row has a
                  menu and every row's time steps aside for it. */}
              <span
                className={cn(
                  "text-xs tabular-nums transition-opacity text-muted-foreground/55 group-hover/v2-row:opacity-0",
                  menuOpen && "opacity-0",
                  rowAction === "unsnooze" &&
                    snoozeWakeLabelText !== null &&
                    "text-blue-600 dark:text-blue-400",
                )}
              >
                {trailingLabel}
              </span>
              {/* Focus-reachable, not hover-only: the row is tabbable and this
                  is the next stop after it, so the menu opens from the keyboard
                  without a pointer ever touching the row. */}
              <span
                className={cn(
                  "absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100",
                  menuOpen && "opacity-100",
                )}
              >
                <ThreadRowMenu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  thread={thread}
                  driverKind={driverKind}
                  rowAction={rowAction}
                  settlementSupported={settlementSupported}
                  snoozeAllowed={snoozeAllowed}
                  snoozeSupported={snoozeSupported}
                  splitState={splitState}
                  onOpenInSplit={onOpenInSplit}
                  onRename={actions.onStartRename}
                  onSettle={actions.onSettle}
                  onUnsettle={actions.onUnsettle}
                  onUnsnooze={actions.onUnsnooze}
                  onSnooze={actions.onSnooze}
                />
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
