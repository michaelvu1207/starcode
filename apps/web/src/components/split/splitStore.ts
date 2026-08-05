/**
 * Fork-owned: the second pane, and which pane the keyboard belongs to.
 *
 * The primary thread stays in the URL — `/$environmentId/$threadId` is
 * untouched, so every existing link, back button and `router.navigate` call
 * keeps working with no edits. Only the *second* thread lives here, because
 * putting it in the route would mean either route-tree surgery or auditing
 * every navigate call site for search-param preservation, for a shareable-link
 * benefit nobody asked for. The store holds a full `ScopedThreadRef`, so a
 * `?split=` hydration source is an additive upgrade later rather than a
 * rewrite.
 *
 * `focusedPane` is deliberately *not* persisted: which pane you last touched
 * is a property of a session, and restoring it would hand the keyboard to a
 * pane the user has not looked at yet.
 *
 * @module splitStore
 */
import type { ScopedThreadRef } from "@starcode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_STORAGE_KEY,
  type SplitPaneId,
  type SplitRenderState,
} from "./Split.logic";

export interface SplitStoreState {
  /** The user has asked for a split. Says nothing about whether one fits. */
  enabled: boolean;
  secondary: ScopedThreadRef | null;
  /** Primary pane's share of the width, 0..1. Clamped at the container. */
  ratio: number;
  focusedPane: SplitPaneId;
  /**
   * What the split actually resolved to once the viewport had its say.
   * Published by `SplitContainer` so key handlers can read the owner
   * synchronously, without a hook and without re-subscribing.
   *
   * Only a *mounted* container can answer this, which is why
   * `releaseContainer` exists: read on a route that mounts no container, a
   * left-over `"split"` is a claim about a pane that is not on screen.
   */
  renderState: SplitRenderState;
  /**
   * Last measured width of the pane region, `null` before first measure.
   * Published alongside `renderState` so the affordance can say *why* it is
   * unavailable instead of just vanishing.
   */
  containerWidth: number | null;

  setRenderState: (renderState: SplitRenderState, containerWidth: number | null) => void;
  /**
   * The container is gone — nothing is publishing these any more.
   *
   * `renderState`, `containerWidth` and `focusedPane` all describe a split
   * that is on screen, and only `SplitContainer` can say so. Without this,
   * leaving a live split for a route that mounts no container (the project
   * home, the workbench, the projects index) left `"split"` and a focused
   * second pane standing, and `openThreadInFocusedPane` went on answering
   * "put it in the second pane" for a second pane that no longer existed —
   * so every sidebar thread click on those routes was silently swallowed.
   */
  releaseContainer: () => void;
  openSplit: () => void;
  closeSplit: () => void;
  setSecondary: (ref: ScopedThreadRef | null) => void;
  setRatio: (ratio: number) => void;
  resetRatio: () => void;
  focusPane: (pane: SplitPaneId) => void;
}

export const useSplitStore = create<SplitStoreState>()(
  persist(
    (set) => ({
      enabled: false,
      secondary: null,
      ratio: SPLIT_DEFAULT_RATIO,
      focusedPane: "primary",
      renderState: "off",
      containerWidth: null,

      setRenderState: (renderState, containerWidth) =>
        set((state) =>
          state.renderState === renderState && state.containerWidth === containerWidth
            ? state
            : { renderState, containerWidth },
        ),
      releaseContainer: () =>
        set((state) =>
          state.renderState === "off" &&
          state.containerWidth === null &&
          state.focusedPane === "primary"
            ? state
            : { renderState: "off", containerWidth: null, focusedPane: "primary" },
        ),
      // Opening focuses the empty pane, so the first sidebar click after
      // splitting fills it without a second affordance.
      openSplit: () => set({ enabled: true, focusedPane: "secondary" }),
      closeSplit: () => set({ enabled: false, focusedPane: "primary" }),
      setSecondary: (ref) => set({ secondary: ref, focusedPane: "secondary" }),
      setRatio: (ratio) => set({ ratio }),
      resetRatio: () => set({ ratio: SPLIT_DEFAULT_RATIO }),
      focusPane: (pane) => set({ focusedPane: pane }),
    }),
    {
      name: SPLIT_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? null : window.localStorage),
      ),
      partialize: (state) => ({
        enabled: state.enabled,
        secondary: state.secondary,
        ratio: state.ratio,
      }),
    },
  ),
);

/** Read the current owner inputs without subscribing. Used by key handlers. */
export function readSplitState(): SplitStoreState {
  return useSplitStore.getState();
}
