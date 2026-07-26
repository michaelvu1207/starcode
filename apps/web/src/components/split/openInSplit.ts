/**
 * Fork-owned: opening a *named* thread in the second pane, and deciding where
 * the split toggle lives.
 *
 * The split shipped with exactly one way in — a row inside the composer's `···`
 * popover — and the first thing anyone asked was where it was. Two answers
 * here. `useCanOpenInSplit` puts "Open in split" on the sidebar row menu, which
 * is where you are when you already know which thread you want beside this one;
 * `resolveSplitControlPlacement` lifts the toggle out of the popover and onto
 * the composer footer, which is where you are when you do not.
 *
 * This is a different verb from `openThreadInFocusedPane`. That one answers
 * "the user clicked a thread, where does it land" and defers to whichever pane
 * has focus. This one answers "the user asked for *this* thread, beside the one
 * they are reading" — so it opens the split if it is closed, and always targets
 * the second pane.
 *
 * @module openInSplit
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { splitFitsContainer, type SplitPaneId, type SplitRenderState } from "./Split.logic";
import { useSplitStore } from "./splitStore";

/**
 * Whether a given thread's row menu offers "Open in split".
 *
 * Three ways to answer no, and all three are cases where the entry would either
 * fail or do nothing visible:
 *
 * - the window cannot hold two panes, so a split would resolve straight back to
 *   `off` and the click would look broken;
 * - the thread is already the second pane;
 * - the thread is the one the route is showing. With a split live it is the
 *   left pane already, and with the split closed this would put the same
 *   transcript on both sides of the divider.
 */
export function resolveOpenInSplitAvailability(input: {
  readonly renderState: SplitRenderState;
  /** `null` before the pane region has been measured — treated as "fits". */
  readonly containerWidth: number | null;
  readonly isRouteThread: boolean;
  readonly isSecondaryThread: boolean;
}): boolean {
  if (input.containerWidth !== null && !splitFitsContainer(input.containerWidth)) return false;
  if (input.isSecondaryThread) return false;
  if (input.isRouteThread) return false;
  return true;
}

/** The hook form, for the sidebar row that has to decide twice: once for the
 *  entry itself, and once for whether the `···` has anything in it at all. */
export function useCanOpenInSplit(input: {
  readonly threadRef: ScopedThreadRef;
  /** The row already knows this — it is what paints the row as active. */
  readonly isRouteThread: boolean;
}): boolean {
  const renderState = useSplitStore((state) => state.renderState);
  const containerWidth = useSplitStore((state) => state.containerWidth);
  const secondary = useSplitStore((state) => state.secondary);
  return resolveOpenInSplitAvailability({
    renderState,
    containerWidth,
    isRouteThread: input.isRouteThread,
    isSecondaryThread:
      secondary !== null && scopedThreadKey(secondary) === scopedThreadKey(input.threadRef),
  });
}

/**
 * Put this thread in the second pane, opening the split if it is closed.
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

/**
 * Where the split toggle renders.
 *
 * `"footer"` is a persistent icon beside the composer's `···`; `"menu"` is the
 * labelled row inside that popover. Exactly one of them shows, so the control
 * is never duplicated and never silently absent.
 *
 * The split is worth a permanent slot in the footer only where it is actually
 * reachable, and below two minimum panes it is not. That case keeps the popover
 * row instead, because the row can afford a disabled button that says *why* —
 * a footer icon that vanished on narrow windows would read as a bug, which is
 * the failure this whole round is fixing.
 */
export function resolveSplitControlPlacement(input: {
  readonly paneId: SplitPaneId | null;
  readonly containerWidth: number | null;
}): "footer" | "menu" {
  // The second pane only exists inside a live split, so the width question is
  // already answered, and its controls are the ones you reach for most.
  if (input.paneId === "secondary") return "footer";
  if (input.containerWidth === null) return "footer";
  return splitFitsContainer(input.containerWidth) ? "footer" : "menu";
}
