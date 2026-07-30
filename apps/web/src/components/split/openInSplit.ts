/**
 * Fork-owned: opening a *named* thread to the right of the one you are reading.
 *
 * The split shipped with one way in — a row inside the composer's `···` popover
 * — and the first thing anyone asked was where it was. The entry belongs on the
 * sidebar row instead, because that is where you are standing when you know
 * which thread you want beside this one: you are looking at its name.
 *
 * The semantics are the ones the affordance's position implies. The thread you
 * are already reading does not move — it stays the left pane, and the row you
 * opened the menu on fills the right. Invoke it again on a different row and
 * the right pane is replaced, not stacked.
 *
 * This is a different verb from `openThreadInFocusedPane`. That one answers
 * "the user clicked a thread, where does it land" and defers to whichever pane
 * has focus. This one answers "the user asked for *this* thread, beside the one
 * they are reading" — so it opens the split if it is closed, and always targets
 * the second pane.
 *
 * The composer's popover keeps its own split row. That one closes the pane and
 * swaps what is in it, which is management of a split you already have; this is
 * how you get one.
 *
 * @module openInSplit
 */
import { scopedThreadKey } from "@starcode/client-runtime/environment";
import type { ScopedThreadRef } from "@starcode/contracts";

import { splitFitsContainer } from "./Split.logic";
import { useSplitStore } from "./splitStore";

/**
 * What a row's menu does about the split.
 *
 * - `hidden` — no entry, and no `···` earned on its own account. Either the
 *   window cannot hold two panes, or no thread is open for a second one to sit
 *   beside.
 * - `ready` — an enabled "Open in split view".
 * - `already-primary` / `already-secondary` — the thread is already on screen,
 *   in one pane or the other. The entry stays, disabled, saying which. Shown
 *   rather than hidden because an item that vanishes on exactly one row
 *   explains itself worse than one that greys out — but deliberately not enough
 *   to summon a menu that would otherwise be empty, since a `···` holding one
 *   greyed line is the same lie as an empty one.
 */
export type OpenInSplitState = "hidden" | "ready" | "already-primary" | "already-secondary";

export function resolveOpenInSplitState(input: {
  /** `null` before the pane region has been measured — treated as "fits". */
  readonly containerWidth: number | null;
  /**
   * Whether a thread is open at all. The split container is mounted by the
   * thread route, so on `/projects` or a draft there is no left pane for a
   * second one to open beside and the entry would do nothing.
   */
  readonly hasRouteThread: boolean;
  readonly isRouteThread: boolean;
  readonly isSecondaryThread: boolean;
}): OpenInSplitState {
  if (!input.hasRouteThread) return "hidden";
  // A split below this width resolves straight back to `off`, so the click
  // would read as broken rather than as unavailable.
  if (input.containerWidth !== null && !splitFitsContainer(input.containerWidth)) return "hidden";
  if (input.isSecondaryThread) return "already-secondary";
  if (input.isRouteThread) return "already-primary";
  return "ready";
}

/** The hook form, resolved once per row by `SidebarV2Row`. */
export function useOpenInSplitState(input: {
  readonly threadRef: ScopedThreadRef;
  /** The row already knows this — it is what paints the row as active. */
  readonly isRouteThread: boolean;
  readonly hasRouteThread: boolean;
}): OpenInSplitState {
  const containerWidth = useSplitStore((state) => state.containerWidth);
  const secondary = useSplitStore((state) => state.secondary);
  return resolveOpenInSplitState({
    containerWidth,
    hasRouteThread: input.hasRouteThread,
    isRouteThread: input.isRouteThread,
    isSecondaryThread:
      secondary !== null && scopedThreadKey(secondary) === scopedThreadKey(input.threadRef),
  });
}

/**
 * Put this thread in the right-hand pane, opening the split if it is closed.
 * The route — and so the left pane — is untouched.
 *
 * Not a hook: it is called from a menu item's `onClick`, and reading the store
 * imperatively means the sidebar does not re-render every row when the split
 * ratio moves.
 */
export function openThreadInSplit(threadRef: ScopedThreadRef): void {
  const state = useSplitStore.getState();
  if (!state.enabled) state.openSplit();
  state.setSecondary(threadRef);
}
