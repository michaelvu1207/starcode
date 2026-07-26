import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { SPLIT_DEFAULT_RATIO } from "./Split.logic";
import { openThreadInFocusedPane } from "./openThreadInFocusedPane";
import { useSplitStore } from "./splitStore";

const target = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));

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
      expect(openThreadInFocusedPane(target)).toBe(false);
      expect(useSplitStore.getState().secondary).toBeNull();
    }
  });

  it("navigates when the primary pane is the focused one", () => {
    useSplitStore.setState({ renderState: "split", focusedPane: "primary" });
    expect(openThreadInFocusedPane(target)).toBe(false);
    expect(useSplitStore.getState().secondary).toBeNull();
  });

  it("fills the empty pane the split just opened", () => {
    useSplitStore.setState({ enabled: true, renderState: "picking", focusedPane: "secondary" });
    expect(openThreadInFocusedPane(target)).toBe(true);
    expect(useSplitStore.getState().secondary).toEqual(target);
  });

  it("replaces the second pane's thread when that pane is focused", () => {
    const other = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("thread-b"));
    useSplitStore.setState({
      enabled: true,
      renderState: "split",
      focusedPane: "secondary",
      secondary: other,
    });
    expect(openThreadInFocusedPane(target)).toBe(true);
    expect(useSplitStore.getState().secondary).toEqual(target);
  });
});
