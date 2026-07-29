/**
 * What a thread row says about itself, in one word.
 *
 * Lifted out of the row's JSX so the precedence is testable, because the
 * precedence is the whole of it: a thread can be several of these at once and
 * only one wins. Live states beat remembered ones — an agent that is working,
 * or blocked on you, or that failed, outranks "you have not read this yet",
 * because the first three are things happening now and the last is a note about
 * the past.
 *
 * `null` is the common case and means the row shows no chip at all. Most rows
 * in a healthy list are quiet, and a list where every row wears a badge has
 * told you nothing.
 *
 * The tone names the *shape* the row draws, not a colour: since the glyph took
 * on its machine's hue, colour answers "where does this run" and the glyph
 * answers "what is it doing".
 */
import type { SidebarV2Status } from "../Sidebar.logic";

export type ThreadRowStatusTone = "working" | "approval" | "input" | "agents" | "failed" | "done";

export interface ThreadRowStatusChip {
  readonly tone: ThreadRowStatusTone;
  /** The accessible name; the row renders the tone as a glyph. */
  readonly label: string;
}

export function resolveThreadRowStatusChip(input: {
  readonly status: SidebarV2Status;
  readonly isUnread: boolean;
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
    // Its own tone rather than a variant of "working", because it answers a
    // different question: the thread is not working, but it is not finished
    // either. The child rows below it say which agents are still going.
    case "agents":
      return { tone: "agents", label: "Background agents running" };
    case "ready":
      break;
  }
  if (input.isUnread) return { tone: "done", label: "Done" };
  return null;
}
