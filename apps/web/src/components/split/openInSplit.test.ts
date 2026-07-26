import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import composerPaneMenuSource from "../chat/ComposerPaneMenu.tsx?raw";
import { describe, expect, it } from "vite-plus/test";

import { SPLIT_DIVIDER_PX, SPLIT_MIN_PANE_PX } from "./Split.logic";
import {
  openThreadInSplit,
  resolveOpenInSplitAvailability,
  resolveSplitControlPlacement,
} from "./openInSplit";
import { useSplitStore } from "./splitStore";

const WIDE = SPLIT_MIN_PANE_PX * 2 + SPLIT_DIVIDER_PX;
const NARROW = WIDE - 1;

const base = {
  renderState: "off",
  containerWidth: WIDE,
  isRouteThread: false,
  isSecondaryThread: false,
} as const;

describe("resolveOpenInSplitAvailability", () => {
  it("offers the entry on an ordinary row in a window wide enough for two panes", () => {
    expect(resolveOpenInSplitAvailability(base)).toBe(true);
  });

  it("withholds it one pixel below the width two panes need", () => {
    // The boundary and not a round number: a click here would open a split that
    // resolves straight back to `off`, which reads as a dead menu item.
    expect(resolveOpenInSplitAvailability({ ...base, containerWidth: WIDE })).toBe(true);
    expect(resolveOpenInSplitAvailability({ ...base, containerWidth: NARROW })).toBe(false);
  });

  it("allows it before the pane region has been measured", () => {
    // `null` is the first frame, not a narrow window. Treating it as narrow
    // would hide the entry from every row until a resize happened to fire.
    expect(resolveOpenInSplitAvailability({ ...base, containerWidth: null })).toBe(true);
  });

  it("withholds it on the thread the second pane is already showing", () => {
    expect(
      resolveOpenInSplitAvailability({
        ...base,
        renderState: "split",
        isSecondaryThread: true,
      }),
    ).toBe(false);
  });

  it("withholds it on the thread the route is showing, split or not", () => {
    // With a split live it is the left pane already; with the split closed this
    // would put the same transcript on both sides of the divider.
    expect(resolveOpenInSplitAvailability({ ...base, isRouteThread: true })).toBe(false);
    expect(
      resolveOpenInSplitAvailability({ ...base, renderState: "split", isRouteThread: true }),
    ).toBe(false);
  });
});

describe("resolveSplitControlPlacement", () => {
  it("puts the toggle in the composer footer wherever a split fits", () => {
    expect(resolveSplitControlPlacement({ paneId: null, containerWidth: WIDE })).toBe("footer");
    expect(resolveSplitControlPlacement({ paneId: "primary", containerWidth: WIDE })).toBe(
      "footer",
    );
  });

  it("falls back to the popover row only when the window is too narrow", () => {
    // The row is kept for this case alone: it can carry a disabled button that
    // says why, which a bare icon in the footer cannot.
    expect(resolveSplitControlPlacement({ paneId: "primary", containerWidth: NARROW })).toBe(
      "menu",
    );
  });

  it("keeps the second pane's own controls in its footer whatever the measurement says", () => {
    // A second pane only exists inside a live split, so a width that claims
    // otherwise is a stale measurement, not a reason to hide its close button.
    expect(resolveSplitControlPlacement({ paneId: "secondary", containerWidth: NARROW })).toBe(
      "footer",
    );
  });

  it("shows exactly one of the two, never both and never neither", () => {
    for (const width of [null, NARROW, WIDE]) {
      for (const paneId of [null, "primary", "secondary"] as const) {
        expect(["footer", "menu"]).toContain(
          resolveSplitControlPlacement({ paneId, containerWidth: width }),
        );
      }
    }
  });
});

describe("openThreadInSplit", () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("t-9"));

  it("opens the split when it is closed and puts the thread in the second pane", () => {
    useSplitStore.setState({ enabled: false, secondary: null, focusedPane: "primary" });

    openThreadInSplit(threadRef);

    const state = useSplitStore.getState();
    expect(state.enabled).toBe(true);
    expect(state.secondary).toEqual(threadRef);
    // The second pane takes the keyboard, so the thread you just asked for is
    // the one the next keystroke reaches.
    expect(state.focusedPane).toBe("secondary");
  });

  it("replaces the second pane's thread when the split is already open", () => {
    const other = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("t-1"));
    useSplitStore.setState({ enabled: true, secondary: other, focusedPane: "primary" });

    openThreadInSplit(threadRef);

    expect(useSplitStore.getState().secondary).toEqual(threadRef);
  });
});

describe("the composer footer wiring", () => {
  it("renders the split controls outside the popover, not inside it", () => {
    // Read from the source because the popover only mounts its contents in a
    // browser, so a rendered test cannot tell the two placements apart — and
    // "the control is in the markup" was exactly the assertion that let a
    // dead button ship last round. What matters here is *where*.
    const controls = composerPaneMenuSource.indexOf("<SplitPaneMenuControls />");
    const popover = composerPaneMenuSource.indexOf("<Popover>");
    expect(controls).toBeGreaterThan(-1);
    expect(popover).toBeGreaterThan(-1);
    expect(controls).toBeLessThan(popover);
  });
});
