/**
 * Fork-owned: the one place that decides whether opening a thread navigates
 * or fills the second pane.
 *
 * The sidebar keeps its single `navigateToThread` callback and gains one
 * line, which is the same call-site discipline the other fork features use in
 * that file. With the split off this returns `false` for every input, so the
 * sidebar navigates exactly as it always did.
 *
 * @module openThreadInFocusedPane
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

import { resolveSidebarOpenTarget } from "./Split.logic";
import { useSplitStore } from "./splitStore";

/**
 * Returns `true` when the thread was placed in the second pane and the caller
 * should not navigate.
 *
 * `hasRouteThread` says whether the caller is standing on a route that mounts
 * a split at all. It is required rather than inferred because the store's
 * `renderState` is only as fresh as the last container to publish it, and the
 * routes that mount none — the project home, the workbench, the projects
 * index — are exactly the ones where a stale `"split"` would eat every click.
 */
export function openThreadInFocusedPane(
  threadRef: ScopedThreadRef,
  options: { readonly hasRouteThread: boolean },
): boolean {
  const { renderState, focusedPane, setSecondary } = useSplitStore.getState();
  if (
    resolveSidebarOpenTarget({
      hasRouteThread: options.hasRouteThread,
      renderState,
      focusedPane,
    }) === "navigate"
  ) {
    return false;
  }
  setSecondary(threadRef);
  return true;
}

/**
 * The thread the focused pane is showing — the route's thread unless a live
 * split has handed the keyboard to the second pane.
 *
 * Used by the route-level shortcut handler so `when:` context flags like
 * `terminalOpen` and `previewOpen` describe the pane the command will
 * actually reach.
 */
export function useFocusedPaneThreadRef(routeThreadRef: ScopedThreadRef | null) {
  const renderState = useSplitStore((state) => state.renderState);
  const focusedPane = useSplitStore((state) => state.focusedPane);
  const secondary = useSplitStore((state) => state.secondary);
  if (renderState !== "split" || focusedPane !== "secondary") return routeThreadRef;
  return secondary ?? routeThreadRef;
}
