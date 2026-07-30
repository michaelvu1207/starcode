import { scopeThreadRef } from "@starcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@starcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { SPLIT_DEFAULT_RATIO } from "./Split.logic";
import { openThreadInFocusedPane } from "./openThreadInFocusedPane";
import { useSplitStore } from "./splitStore";

const target = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const other = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("thread-b"));

/** The sidebar's own answer while the thread route is on screen. */
const onThreadRoute = { hasRouteThread: true } as const;

describe("openThreadInFocusedPane", () => {
  beforeEach(() => {
    useSplitStore.setState({
      enabled: false,
      secondary: null,
      ratio: SPLIT_DEFAULT_RATIO,
      focusedPane: "primary",
      renderState: "off",
      containerWidth: null,
    });
  });

  // The regression gate for the sidebar: with the split off this must never
  // intercept, so `navigateToThread` behaves exactly as it always did.
  it("never intercepts while the split is off", () => {
    for (const focusedPane of ["primary", "secondary"] as const) {
      useSplitStore.setState({ focusedPane });
      expect(openThreadInFocusedPane(target, onThreadRoute)).toBe(false);
      expect(useSplitStore.getState().secondary).toBeNull();
    }
  });

  it("navigates when the primary pane is the focused one", () => {
    useSplitStore.setState({ renderState: "split", focusedPane: "primary" });
    expect(openThreadInFocusedPane(target, onThreadRoute)).toBe(false);
    expect(useSplitStore.getState().secondary).toBeNull();
  });

  it("fills the empty pane the split just opened", () => {
    useSplitStore.setState({ enabled: true, renderState: "picking", focusedPane: "secondary" });
    expect(openThreadInFocusedPane(target, onThreadRoute)).toBe(true);
    expect(useSplitStore.getState().secondary).toEqual(target);
  });

  it("replaces the second pane's thread when that pane is focused", () => {
    useSplitStore.setState({
      enabled: true,
      renderState: "split",
      focusedPane: "secondary",
      secondary: other,
    });
    expect(openThreadInFocusedPane(target, onThreadRoute)).toBe(true);
    expect(useSplitStore.getState().secondary).toEqual(target);
  });

  /**
   * The bug this module's one line caused, from both ends.
   *
   * `SplitContainer` is mounted by the thread route and by nothing else, so
   * walking from a live split to the project home, the workbench or the
   * projects index left `renderState: "split"` with the second pane still
   * focused, published by a container that had unmounted. Every sidebar
   * thread click on those routes was answered as "fill the second pane" — a
   * pane nothing was drawing — and read to the operator as a sidebar that had
   * stopped working.
   *
   * Two things now prevent it, and both are asserted here because they fail
   * independently: the route says there is no pane to fill, and the container
   * takes its published state with it when it goes.
   */
  it("navigates on a route that mounts no split, however the store was left", () => {
    useSplitStore.setState({
      enabled: true,
      renderState: "split",
      focusedPane: "secondary",
      secondary: other,
      containerWidth: 1400,
    });

    expect(openThreadInFocusedPane(target, { hasRouteThread: false })).toBe(false);
    expect(useSplitStore.getState().secondary).toEqual(other);
  });

  it("navigates once the container that published the split has unmounted", () => {
    useSplitStore.setState({
      enabled: true,
      renderState: "split",
      focusedPane: "secondary",
      secondary: other,
      containerWidth: 1400,
    });

    // What unmounting `SplitContainer` does.
    useSplitStore.getState().releaseContainer();

    expect(openThreadInFocusedPane(target, onThreadRoute)).toBe(false);
    expect(useSplitStore.getState().secondary).toEqual(other);
  });
});
