import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import moduleSource from "./openInSplit.ts?raw";
import sidebarSource from "../SidebarV2.tsx?raw";
import { SPLIT_DIVIDER_PX, SPLIT_MIN_PANE_PX } from "./Split.logic";
import { openThreadInSplit, resolveOpenInSplitState } from "./openInSplit";
import { useSplitStore } from "./splitStore";

const WIDE = SPLIT_MIN_PANE_PX * 2 + SPLIT_DIVIDER_PX;
const NARROW = WIDE - 1;

const base = {
  containerWidth: WIDE,
  hasRouteThread: true,
  isRouteThread: false,
  isSecondaryThread: false,
} as const;

describe("resolveOpenInSplitState", () => {
  it("offers the entry on an ordinary row while a thread is open", () => {
    expect(resolveOpenInSplitState(base)).toBe("ready");
  });

  it("hides it when no thread is open to split against", () => {
    // The split container is mounted by the thread route. On /projects or a
    // fresh draft there is no left pane, so the entry would open a right pane
    // beside nothing.
    expect(resolveOpenInSplitState({ ...base, hasRouteThread: false })).toBe("hidden");
  });

  it("hides it one pixel below the width two panes need", () => {
    // The boundary and not a round number: a click here would open a split that
    // resolves straight back to `off`, which reads as a dead menu item.
    expect(resolveOpenInSplitState({ ...base, containerWidth: WIDE })).toBe("ready");
    expect(resolveOpenInSplitState({ ...base, containerWidth: NARROW })).toBe("hidden");
  });

  it("allows it before the pane region has been measured", () => {
    // `null` is the first frame, not a narrow window. Treating it as narrow
    // would hide the entry from every row until a resize happened to fire.
    expect(resolveOpenInSplitState({ ...base, containerWidth: null })).toBe("ready");
  });

  it("greys it out on the thread you are reading rather than acting on it", () => {
    // This is the left pane. Opening it in the split would put one transcript
    // on both sides of the divider.
    expect(resolveOpenInSplitState({ ...base, isRouteThread: true })).toBe("already-primary");
  });

  it("greys it out on the thread the right pane already holds", () => {
    expect(resolveOpenInSplitState({ ...base, isSecondaryThread: true })).toBe("already-secondary");
  });

  it("puts the hard gates ahead of the two soft ones", () => {
    // A row that is both the route thread and in a window too narrow to split
    // reads "hidden", not a disabled entry promising something impossible.
    expect(resolveOpenInSplitState({ ...base, containerWidth: NARROW, isRouteThread: true })).toBe(
      "hidden",
    );
    expect(resolveOpenInSplitState({ ...base, hasRouteThread: false, isRouteThread: true })).toBe(
      "hidden",
    );
  });
});

describe("openThreadInSplit", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("t-9"));

  it("opens the split when it is closed and puts the thread in the right pane", () => {
    useSplitStore.setState({ enabled: false, secondary: null, focusedPane: "primary" });

    openThreadInSplit(threadRef);

    const state = useSplitStore.getState();
    expect(state.enabled).toBe(true);
    expect(state.secondary).toEqual(threadRef);
    // The right pane takes the keyboard, so the thread you just asked for is
    // the one the next keystroke reaches.
    expect(state.focusedPane).toBe("secondary");
  });

  it("replaces the right pane's thread rather than stacking, when a split is open", () => {
    const other = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("t-1"));
    useSplitStore.setState({ enabled: true, secondary: other, focusedPane: "primary" });

    openThreadInSplit(threadRef);

    expect(useSplitStore.getState().secondary).toEqual(threadRef);
  });

  it("never touches the route, so the thread you are reading keeps the left pane", () => {
    // The whole point of the affordance's position: the row you invoked it on
    // fills the right pane, and the thread you were reading stays put on the
    // left. The left pane's identity *is* the route, so the way this breaks is
    // someone reaching for the router here — which is also the one thing a
    // store assertion cannot see. So it is checked at the seam it would cross.
    expect(moduleSource).not.toContain("@tanstack/react-router");
    expect(moduleSource).not.toContain("navigate");
  });
});

describe("the row's split entry reaches every sidebar view", () => {
  it("is resolved once on the shared row, not per view", () => {
    // The projects groups, the Chats dock, the connections view and the inbox
    // shelves all render through the one `renderThreadRow` callback, so the
    // entry cannot be present in one view and missing from another. This is the
    // assertion that a fifth view would have to keep true.
    const rowUsages = sidebarSource.match(/<SidebarThreadRow/g) ?? [];
    expect(rowUsages).toHaveLength(1);
    expect(sidebarSource).toContain("useOpenInSplitState({");
    for (const view of ["SidebarConnectionsView", "SidebarProjectsView"]) {
      const usage = sidebarSource.slice(sidebarSource.indexOf(`<${view}`));
      expect(usage.slice(0, 400)).toContain("renderThreadRow={renderThreadRow}");
    }
  });
});
