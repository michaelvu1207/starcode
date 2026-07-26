/**
 * What a thread row says about itself, in one word.
 *
 * Lifted out of the row's JSX so the precedence is testable, because the
 * precedence is the whole of it: a thread can be several of these at once and
 * only one wins. Live states beat remembered ones — an agent that is working,
 * or blocked on you, or that failed, outranks "you have not read this yet",
 * because the first three are things happening now and the last is a note about
 * the past. Between the two remembered states, a wake beats an unread finish:
 * you asked for the thread back at this hour, so that is the more surprising
 * fact.
 *
 * `null` is the common case and means the row shows no chip at all. Most rows
 * in a healthy list are quiet, and a list where every row wears a badge has
 * told you nothing.
 */
import type { SidebarV2Status } from "../Sidebar.logic";

export type ThreadRowStatusTone = "working" | "approval" | "input" | "failed" | "woke" | "done";

export interface ThreadRowStatusChip {
  readonly tone: ThreadRowStatusTone;
  /** The accessible name; the row renders the tone as colour and a glyph. */
  readonly label: string;
}

export function resolveThreadRowStatusChip(input: {
  readonly status: SidebarV2Status;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): ThreadRowStatusChip | null {
  switch (input.status) {
    case "working":
      return { tone: "working", label: "Working" };
    case "approval":
      return { tone: "approval", label: "Waiting for approval" };
    case "input":
      return { tone: "input", label: "Waiting for input" };
    case "failed":
      return { tone: "failed", label: "Failed" };
    case "ready":
      break;
  }
  if (input.isWoke) return { tone: "woke", label: "Woke from snooze" };
  if (input.isUnread) return { tone: "done", label: "Done" };
  return null;
}
