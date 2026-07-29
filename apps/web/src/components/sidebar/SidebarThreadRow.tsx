/**
 * The sidebar thread row. One row, one shape, every view.
 *
 * There used to be two: an elevated three-line card for live threads and a
 * one-line slim row for the ones that had been put away. That is two layouts
 * for one object, and a list containing both read as two lists stapled
 * together. The card also spent 78px and three lines saying what fits on one.
 *
 * What is on the row, and nothing else: the thread's name, and when it last
 * spoke. Status is a glyph in front of the time, and how far through its task
 * list the thread is is a hairline along the bottom edge. Everything the card
 * used to spell out — project name, machine name, model, branch, task counts,
 * the failure — is in the tooltip, which is where second-order detail belongs
 * on a surface you scan forty times a day.
 *
 * The machine is in the status glyph's *colour* rather than in a mark of its
 * own. Two glyphs at the edges of a 32px row is one more than carries its
 * weight, and the two facts compose cleanly: the shape says what the thread is
 * doing, the hue says where it is doing it. A quiet thread draws neither, which
 * is the point — a list where every row wears a badge has told you nothing.
 *
 * Three more things are deliberately absent. There is no rounded card: the
 * hover and selection surfaces are full-bleed bands, so a list of threads reads
 * as a list and not as a stack of tiles. There is no ticking work duration; the
 * working glyph pulses, which answers "is it running" without a second of
 * layout churn per second. And there is no agent glyph: which of Claude or
 * Codex is driving is not how you pick a thread out of a list, and it is named
 * beside its model in the tooltip.
 *
 * Fork-owned and purely presentational. Every piece of state and every handler
 * arrives as a prop from `SidebarV2Row`, which keeps the hooks, the git lookups
 * and the rename plumbing where upstream put them — so the permanent diff in
 * `SidebarV2.tsx` is the JSX this file replaced and nothing more.
 */
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarV2Status } from "../Sidebar.logic";
import {
  ArchiveIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  Columns2Icon,
  EllipsisIcon,
  BotIcon,
} from "lucide-react";
import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import type { OpenInSplitState } from "../split/openInSplit";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { connectionAccentHue } from "./ConnectionMark.model";
import { ThreadRowArchiveAction, ThreadRowFilingActions } from "./SidebarThreadRowActions";
import { ThreadTaskProgress } from "./ThreadTaskProgress";
import { hasThreadTaskProgress } from "./ThreadTaskProgress.logic";
import { resolveThreadRowStatusChip, type ThreadRowStatusTone } from "./SidebarThreadRow.status";
import "./Connections.css";

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
    // The only glyph in the set that is not a circle, deliberately: every
    // other tone describes the thread's own turn, and this one describes work
    // running beside it. A circle variant would read as another turn state.
    case "agents":
      return <BotIcon aria-hidden className={className} />;
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
 * Now the row holds still and the time's slot fills with two things — archive,
 * and this `···`. The one swap worth making, because the time is the least
 * load-bearing thing on the row and the alternative is either two permanently
 * visible buttons on every row or no room for either.
 *
 * Three blocks, separated, in the order you reach for them: open it beside what
 * you are reading; edit it (rename, file, fork); archive it. Archive is last
 * and alone because it is the only entry that takes the thread off the list —
 * and it is duplicated as the icon button beside this trigger, which is the
 * same act one click sooner.
 *
 * `stopPropagation` on the trigger is not defensive: the whole row is a click
 * target that navigates, so without it opening the menu also opens the thread.
 */
function ThreadRowMenu({
  open,
  onOpenChange,
  thread,
  driverKind,
  splitState,
  onOpenInSplit,
  onRename,
  onArchive,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The thread the verbs below act on; they resolve their own state from it. */
  readonly thread: SidebarThreadSummary;
  /** Which agent drives it. Only some can fork a session — see the fork entry. */
  readonly driverKind: ProviderInstanceEntry["driverKind"] | null;
  /** Whether this thread can go in the right pane — see `openInSplit`. */
  readonly splitState: OpenInSplitState;
  readonly onOpenInSplit: () => void;
  readonly onRename: () => void;
  readonly onArchive: (event: ReactMouseEvent) => void;
}): ReactNode {
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
                not to do. */}
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
        {/* What you do TO the thread: renaming, filing and forking are edits to
            the thread itself. Mounted only while the popup is open — they carry
            their own hooks, and the row is rendered hundreds of times. */}
        {open ? (
          <ThreadRowFilingActions thread={thread} driverKind={driverKind} onRename={onRename} />
        ) : null}
        {/* Alone below the separator: archive is the only entry here that takes
            the thread off the list. */}
        <MenuSeparator />
        <ThreadRowArchiveAction onArchive={onArchive} />
      </MenuPopup>
    </Menu>
  );
}

export interface SidebarThreadRowFlags {
  readonly isActive: boolean;
  readonly isSelected: boolean;
  readonly isUnread: boolean;
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
  /** Takes the thread off the list. The hover button and the menu entry share it. */
  readonly onArchive: (event: ReactMouseEvent) => void;
}

export function SidebarThreadRow({
  thread,
  status,
  flags,
  actions,
  timeLabel,
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
  const chip = resolveThreadRowStatusChip({ status, isUnread: flags.isUnread });
  // Owned here rather than by the caller: which menu is open is presentation,
  // and keeping it in the row is what lets the hover strip stay pinned while
  // the pointer is off in the menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const hasProgress = hasThreadTaskProgress(thread.planSummary);
  // The row's own background, named once: the hover strip paints the same
  // colour so the buttons it reveals sit on the row rather than on the tail of
  // the title they overlap.
  const rowBackgroundClass = flags.isActive
    ? "bg-sidebar-row-active"
    : flags.isSelected
      ? "bg-sidebar-row-selected"
      : "bg-sidebar-row-hover";

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
                flags.isActive
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
              skim. Only the time slot swaps, and only for the hover actions: it
              is the least load-bearing thing on the row, and the alternative is
              two buttons sitting permanently on every row.
              The agent's glyph used to sit here, beside the machine's. Two
              decorative marks in the corner of a row you skim is one more than
              carries its weight, and of the two the agent is the one you rarely
              choose a thread by — it is named, with its model, in the tooltip.
              The machine did not move to the other edge; it moved *into* the
              status glyph, as its hue. */}
          <span className="flex h-6 shrink-0 items-center justify-end gap-2">
            {chip === null ? null : (
              <span
                role="status"
                aria-label={chip.label}
                title={chip.label}
                data-testid="sidebar-v2-row-status"
                data-tone={chip.tone}
                data-environment-id={thread.environmentId}
                // `sc-machine-mark` is the machine's colour, the same rotation
                // the connection groups and the connections dropdown draw — so
                // a thread's status reads as "this machine" without a second
                // glyph to say so. Working still pulses: that is motion, not
                // colour, so the two signals do not compete.
                style={
                  {
                    "--sc-machine-hue": `${connectionAccentHue(thread.environmentId)}deg`,
                  } as never
                }
                className={cn(
                  "sc-machine-mark inline-flex shrink-0 items-center",
                  // Both tones mean "something is happening right now", and the
                  // pulse is what distinguishes live work from a resting state
                  // at a glance.
                  (chip.tone === "working" || chip.tone === "agents") &&
                    "animate-status-pulse motion-reduce:animate-none",
                )}
              >
                <StatusGlyph tone={chip.tone} />
              </span>
            )}
            <span className="relative flex h-6 min-w-7 shrink-0 items-center justify-end">
              {/* The time always makes way now. It used to hold its place on
                  rows whose menu would have been empty — a real case when the
                  only entries were capability-gated — but rename, move, fork
                  and archive ask the server for nothing, so every row has both
                  actions and every row's time steps aside for them. */}
              <span
                className={cn(
                  "text-xs tabular-nums transition-opacity text-muted-foreground/55 group-hover/v2-row:opacity-0",
                  menuOpen && "opacity-0",
                )}
              >
                {timeLabel}
              </span>
              {/* Focus-reachable, not hover-only: the row is tabbable and these
                  are the next stops after it, so both open from the keyboard
                  without a pointer ever touching the row. The strip carries the
                  row's own background because it is wider than the time it
                  replaces and would otherwise float over the title's tail. */}
              <span
                className={cn(
                  "absolute inset-y-0 right-0 flex items-stretch pl-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100",
                  rowBackgroundClass,
                  menuOpen && "opacity-100",
                )}
              >
                {/* Archive earns its own button rather than staying one level
                    down in the menu: it is the only thing you do to a finished
                    thread, and it is what the list is *for* — a thread you are
                    done with should leave in one click, not three. */}
                <button
                  type="button"
                  aria-label="Archive thread"
                  title="Archive thread"
                  data-testid="sidebar-v2-row-archive"
                  onClick={actions.onArchive}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground hover:text-foreground"
                >
                  <ArchiveIcon aria-hidden className="size-3.5" />
                </button>
                <ThreadRowMenu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  thread={thread}
                  driverKind={driverKind}
                  splitState={splitState}
                  onOpenInSplit={onOpenInSplit}
                  onRename={actions.onStartRename}
                  onArchive={actions.onArchive}
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
