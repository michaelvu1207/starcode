import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { SPLIT_DEFAULT_RATIO } from "./Split.logic";
import { useSplitStore } from "./splitStore";

const threadA = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const threadB = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("thread-b"));

describe("splitStore", () => {
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

  it("starts closed, even, and focused on the thread in the URL", () => {
    const state = useSplitStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.secondary).toBeNull();
    expect(state.ratio).toBe(SPLIT_DEFAULT_RATIO);
    expect(state.focusedPane).toBe("primary");
  });

  it("focuses the empty pane when the split opens, so the next click fills it", () => {
    useSplitStore.getState().openSplit();
    expect(useSplitStore.getState().enabled).toBe(true);
    expect(useSplitStore.getState().focusedPane).toBe("secondary");
  });

  it("returns the keyboard to the primary pane when the split closes", () => {
    useSplitStore.getState().openSplit();
    useSplitStore.getState().setSecondary(threadA);
    useSplitStore.getState().closeSplit();
    const state = useSplitStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.focusedPane).toBe("primary");
  });

  it("holds a thread on any machine", () => {
    useSplitStore.getState().setSecondary(threadB);
    expect(useSplitStore.getState().secondary).toEqual(threadB);
  });

  it("drops the second pane when its thread is the one that went away", () => {
    useSplitStore.getState().setSecondary(threadA);
    useSplitStore.getState().clearSecondaryIfMatches(threadB);
    expect(useSplitStore.getState().secondary).toEqual(threadA);
    useSplitStore.getState().clearSecondaryIfMatches(threadA);
    expect(useSplitStore.getState().secondary).toBeNull();
  });

  it("resets the divider to an even split", () => {
    useSplitStore.getState().setRatio(0.22);
    expect(useSplitStore.getState().ratio).toBe(0.22);
    useSplitStore.getState().resetRatio();
    expect(useSplitStore.getState().ratio).toBe(SPLIT_DEFAULT_RATIO);
  });

  it("does not churn subscribers when the render state is unchanged", () => {
    const before = useSplitStore.getState();
    useSplitStore.getState().setRenderState("off", null);
    expect(useSplitStore.getState()).toBe(before);
  });

  // `focusedPane` is session state. Restoring it would hand the keyboard to a
  // pane the user has not looked at since the reload.
  it("persists the split but not which pane had focus", () => {
    useSplitStore.getState().openSplit();
    useSplitStore.getState().setSecondary(threadA);
    useSplitStore.getState().setRatio(0.4);

    const persisted = useSplitStore.persist.getOptions().partialize?.(useSplitStore.getState()) as
      | Record<string, unknown>
      | undefined;

    expect(persisted).toEqual({ enabled: true, secondary: threadA, ratio: 0.4 });
    expect(persisted).not.toHaveProperty("focusedPane");
    expect(persisted).not.toHaveProperty("renderState");
  });
});
