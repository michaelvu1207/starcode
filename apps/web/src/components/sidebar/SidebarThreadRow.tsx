/**
 * The sidebar thread row. One row, one shape, every view.
 *
 * There used to be two: an elevated three-line card for live threads and a
 * one-line slim row for the ones that had been put away. That is two layouts
 * for one object, and a list containing both read as two lists stapled
 * together. The card also spent 78px and three lines saying what fits on one.
 *
 * What is on the row, and nothing else: the thread's name, and when it last
 * spoke. Status is a glyph in front of the title, and how far through its task
 * list the thread is is a hairline along the bottom edge. Everything the card
 * used to spell out — project name, machine name, model, branch, task counts,
 * the failure — is in the tooltip, which is where second-order detail belongs
 * on a surface you scan forty times a day.
 *
 * The machine is in the status glyph's *colour* rather than in a mark of its
 * own. Two glyphs before the title is one more than carries its weight, and the
 * two facts compose cleanly: the shape says what the thread is
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
import type { SidebarThreadSummary } from "../../types";
import type { SidebarV2Status } from "../Sidebar.logic";
import {
  ArchiveIcon,
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { connectionAccentHue } from "./ConnectionMark.model";
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
  /** Takes the thread off the list from the row's one-click archive button. */
  readonly onArchive: (event: ReactMouseEvent) => void;
}

export function SidebarThreadRow({
  thread,
  status,
  flags,
  actions,
  timeLabel,
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
  readonly jumpLabel: string | null;
  readonly renamingTitle: string;
  readonly tooltip: ReactNode;
}): ReactNode {
  const chip = resolveThreadRowStatusChip({ status, isUnread: flags.isUnread });
  const hasProgress = status === "working" && hasThreadTaskProgress(thread.planSummary);
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

          {/* The trailing block holds still. Only the time slot swaps for the
              direct archive action: it is the least load-bearing thing on the
              row, and the alternative is a button sitting permanently on
              every row.
              The agent's glyph used to sit here, beside the machine's. Two
              decorative marks in the corner of a row you skim is one more than
              carries its weight, and of the two the agent is the one you rarely
              choose a thread by — it is named, with its model, in the tooltip.
              The machine is carried by the leading status glyph's hue. */}
          <span className="relative flex h-6 min-w-7 shrink-0 items-center justify-end">
            {/* The time makes way for the one direct row action. Everything
                  else stays in the right-click menu, so no overflow glyph
                  competes with the timestamp while the row is idle. */}
            <span className="text-xs tabular-nums transition-opacity text-muted-foreground/55 group-hover/v2-row:opacity-0">
              {timeLabel}
            </span>
            {/* Focus-reachable, not hover-only: this is the next stop after the
                  row, so archive remains available from the keyboard. The strip
                  carries the row's own background because it is wider than the
                  time it replaces and would otherwise float over the title. */}
            <span
              className={cn(
                "absolute inset-y-0 right-0 flex items-stretch pl-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/v2-row:opacity-100",
                rowBackgroundClass,
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
            </span>
          </span>

          {/* While the thread is actively working, its task list is a hairline
              along the bottom edge rather than a line of its own. Once work
              stops the bar leaves too: a remembered plan is useful in the
              tooltip, but a persistent bar makes a quiet thread look live.
              Giving active progress the full width costs no height and no
              character of the title. */}
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
