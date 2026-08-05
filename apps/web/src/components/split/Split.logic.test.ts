import { describe, expect, it } from "vite-plus/test";

import {
  SPLIT_CLOSE_ARM_FRACTION,
  SPLIT_CLOSE_DISARM_FRACTION,
  SPLIT_DEFAULT_RATIO,
  SPLIT_DIVIDER_PX,
  SPLIT_MIN_PANE_PX,
  clampSplitRatio,
  nextRatioForKey,
  paneOwnsKeyboard,
  resolveKeyboardOwner,
  resolvePendingUserInputDigitSelection,
  resolveSidebarOpenTarget,
  resolveSplitCloseAction,
  resolveSplitCloseArm,
  resolveSplitDragRelease,
  resolveSplitRenderState,
  splitFitsContainer,
  splitGridTemplate,
  splitRatioBounds,
  type SplitPaneId,
  type SplitRenderState,
} from "./Split.logic";

const RENDER_STATES: ReadonlyArray<SplitRenderState> = ["off", "picking", "split"];
const PANE_IDS: ReadonlyArray<SplitPaneId | null> = ["primary", "secondary", null];
const EXACT_FIT = SPLIT_MIN_PANE_PX * 2 + SPLIT_DIVIDER_PX;

describe("splitFitsContainer", () => {
  it("needs two whole panes plus the divider", () => {
    expect(splitFitsContainer(EXACT_FIT)).toBe(true);
    expect(splitFitsContainer(EXACT_FIT - 1)).toBe(false);
  });

  it("rejects a width it cannot reason about", () => {
    expect(splitFitsContainer(Number.NaN)).toBe(false);
  });
});

describe("clampSplitRatio", () => {
  it("keeps both panes above the minimum width", () => {
    const width = 1000;
    const { min, max } = splitRatioBounds(width);
    expect(clampSplitRatio(0.05, width)).toBeCloseTo(min);
    expect(clampSplitRatio(0.95, width)).toBeCloseTo(max);
    // 420 of (1000 - 6) available.
    expect(min).toBeCloseTo(SPLIT_MIN_PANE_PX / (width - SPLIT_DIVIDER_PX));
  });

  it("tightens as the window narrows", () => {
    expect(splitRatioBounds(2000).min).toBeLessThan(splitRatioBounds(1000).min);
  });

  it("passes a stored ratio through before the container is measured", () => {
    expect(clampSplitRatio(0.32, null)).toBe(0.32);
  });

  it("falls back to an even split for a value it cannot use", () => {
    expect(clampSplitRatio(Number.NaN, 1200)).toBe(SPLIT_DEFAULT_RATIO);
  });
});

describe("resolveSplitRenderState", () => {
  it("is off until the user asks for it", () => {
    expect(
      resolveSplitRenderState({
        enabled: false,
        hasSecondary: true,
        isMobile: false,
        containerWidth: 1600,
      }),
    ).toBe("off");
  });

  it("shows the picker while the second pane is empty", () => {
    expect(
      resolveSplitRenderState({
        enabled: true,
        hasSecondary: false,
        isMobile: false,
        containerWidth: 1600,
      }),
    ).toBe("picking");
  });

  it("splits once a second thread is chosen", () => {
    expect(
      resolveSplitRenderState({
        enabled: true,
        hasSecondary: true,
        isMobile: false,
        containerWidth: 1600,
      }),
    ).toBe("split");
  });

  it("collapses on mobile without forgetting the split", () => {
    expect(
      resolveSplitRenderState({
        enabled: true,
        hasSecondary: true,
        isMobile: true,
        containerWidth: 1600,
      }),
    ).toBe("off");
  });

  it("collapses when two panes no longer fit", () => {
    expect(
      resolveSplitRenderState({
        enabled: true,
        hasSecondary: true,
        isMobile: false,
        containerWidth: EXACT_FIT - 1,
      }),
    ).toBe("off");
  });

  it("does not collapse before the container has been measured", () => {
    expect(
      resolveSplitRenderState({
        enabled: true,
        hasSecondary: true,
        isMobile: false,
        containerWidth: null,
      }),
    ).toBe("split");
  });
});

describe("keyboard ownership", () => {
  it("hands every key to the primary pane whenever the split is not live", () => {
    for (const renderState of RENDER_STATES) {
      for (const focusedPane of ["primary", "secondary"] as const) {
        const owner = resolveKeyboardOwner({ renderState, focusedPane });
        expect(owner).toBe(renderState === "split" ? focusedPane : "primary");
      }
    }
  });

  // The regression gate for the rest of the suite: with the split off, the
  // predicate must be true for every caller, so no existing keyboard path
  // changes behaviour.
  it("is true for every pane and every focus while the split is off", () => {
    for (const paneId of PANE_IDS) {
      for (const focusedPane of ["primary", "secondary"] as const) {
        const owner = resolveKeyboardOwner({ renderState: "off", focusedPane });
        expect(paneOwnsKeyboard({ paneId, keyboardOwner: owner })).toBe(
          paneId === null || paneId === "primary",
        );
      }
    }
  });

  it("is true for anything rendered outside a pane", () => {
    expect(paneOwnsKeyboard({ paneId: null, keyboardOwner: "secondary" })).toBe(true);
    expect(paneOwnsKeyboard({ paneId: null, keyboardOwner: "primary" })).toBe(true);
  });

  it("gives a live split exactly one owner", () => {
    const owner = resolveKeyboardOwner({ renderState: "split", focusedPane: "secondary" });
    const owners = (["primary", "secondary"] as const).filter((paneId) =>
      paneOwnsKeyboard({ paneId, keyboardOwner: owner }),
    );
    expect(owners).toEqual(["secondary"]);
  });
});

describe("resolveSidebarOpenTarget", () => {
  it("navigates as it always did when the split is off", () => {
    expect(
      resolveSidebarOpenTarget({
        hasRouteThread: true,
        renderState: "off",
        focusedPane: "secondary",
      }),
    ).toBe("navigate");
  });

  it("fills the second pane while it is the focused one", () => {
    expect(
      resolveSidebarOpenTarget({
        hasRouteThread: true,
        renderState: "picking",
        focusedPane: "secondary",
      }),
    ).toBe("secondary");
    expect(
      resolveSidebarOpenTarget({
        hasRouteThread: true,
        renderState: "split",
        focusedPane: "secondary",
      }),
    ).toBe("secondary");
  });

  it("navigates when the primary pane is focused", () => {
    expect(
      resolveSidebarOpenTarget({
        hasRouteThread: true,
        renderState: "split",
        focusedPane: "primary",
      }),
    ).toBe("navigate");
  });

  /**
   * The bug. Only the thread route mounts `SplitContainer`, so on the project
   * home, the workbench, the projects index and a draft, `renderState` and
   * `focusedPane` still describe the split the operator left behind. Every
   * one of those states must navigate, or the sidebar goes dead on the route
   * the operator is standing on.
   */
  it("navigates on a route with no split, whatever the last one published", () => {
    for (const renderState of RENDER_STATES) {
      for (const focusedPane of ["primary", "secondary"] as const) {
        expect(resolveSidebarOpenTarget({ hasRouteThread: false, renderState, focusedPane })).toBe(
          "navigate",
        );
      }
    }
  });
});

describe("nextRatioForKey", () => {
  const width = 1600;

  it("nudges by 2% and by 10% with shift", () => {
    expect(
      nextRatioForKey({ key: "ArrowRight", shiftKey: false, ratio: 0.5, containerWidth: width }),
    ).toBeCloseTo(0.52);
    expect(
      nextRatioForKey({ key: "ArrowLeft", shiftKey: true, ratio: 0.5, containerWidth: width }),
    ).toBeCloseTo(0.4);
  });

  it("runs Home and End to the clamped extremes", () => {
    const { min, max } = splitRatioBounds(width);
    expect(
      nextRatioForKey({ key: "Home", shiftKey: false, ratio: 0.5, containerWidth: width }),
    ).toBeCloseTo(min);
    expect(
      nextRatioForKey({ key: "End", shiftKey: false, ratio: 0.5, containerWidth: width }),
    ).toBeCloseTo(max);
  });

  it("resets on Enter", () => {
    expect(
      nextRatioForKey({ key: "Enter", shiftKey: false, ratio: 0.2, containerWidth: width }),
    ).toBeCloseTo(SPLIT_DEFAULT_RATIO);
  });

  it("never walks a pane below the minimum", () => {
    const { min } = splitRatioBounds(width);
    let ratio = 0.5;
    for (let index = 0; index < 100; index += 1) {
      ratio =
        nextRatioForKey({ key: "ArrowLeft", shiftKey: true, ratio, containerWidth: width }) ??
        ratio;
    }
    expect(ratio).toBeCloseTo(min);
  });

  it("ignores keys it does not own", () => {
    expect(
      nextRatioForKey({ key: "a", shiftKey: false, ratio: 0.5, containerWidth: width }),
    ).toBeNull();
  });
});

describe("overdrag close", () => {
  const width = 1600;
  const available = width - SPLIT_DIVIDER_PX;
  /** The ratio at which the named pane is `px` wide. */
  const ratioFor = (pane: SplitPaneId, px: number) =>
    pane === "primary" ? px / available : 1 - px / available;
  const armPx = SPLIT_MIN_PANE_PX * SPLIT_CLOSE_ARM_FRACTION;
  const disarmPx = SPLIT_MIN_PANE_PX * SPLIT_CLOSE_DISARM_FRACTION;
  const base = { containerWidth: width, hasSecondary: true, armed: null } as const;

  it("stays quiet for every drag the clamp can absorb", () => {
    const { min, max } = splitRatioBounds(width);
    expect(resolveSplitCloseArm({ ...base, ratio: SPLIT_DEFAULT_RATIO })).toBeNull();
    expect(resolveSplitCloseArm({ ...base, ratio: min })).toBeNull();
    expect(resolveSplitCloseArm({ ...base, ratio: max })).toBeNull();
    // A pane pushed a little under its floor is still an overshoot, not a
    // decision: the threshold sits well past where the divider stopped.
    expect(
      resolveSplitCloseArm({ ...base, ratio: ratioFor("primary", SPLIT_MIN_PANE_PX - 40) }),
    ).toBeNull();
    expect(
      resolveSplitCloseArm({ ...base, ratio: ratioFor("secondary", SPLIT_MIN_PANE_PX - 40) }),
    ).toBeNull();
  });

  /**
   * The direction gate. Crushing a pane must arm *that* pane — an
   * implementation that swaps the two sides, or that reads the clamped ratio
   * instead of the raw pointer projection, fails here.
   */
  it("arms the pane the pointer is squeezing, and only that one", () => {
    expect(resolveSplitCloseArm({ ...base, ratio: ratioFor("primary", armPx - 1) })).toBe(
      "primary",
    );
    expect(resolveSplitCloseArm({ ...base, ratio: ratioFor("secondary", armPx - 1) })).toBe(
      "secondary",
    );
    // Dragging left, all the way off the edge, never arms the right pane.
    for (const ratio of [0.19, 0.1, 0, -0.4]) {
      expect(resolveSplitCloseArm({ ...base, ratio })).toBe("primary");
    }
    for (const ratio of [0.81, 0.9, 1, 1.4]) {
      expect(resolveSplitCloseArm({ ...base, ratio })).toBe("secondary");
    }
  });

  it("takes a real shove past the stop, not an overshoot", () => {
    // 105px of travel into a wall at the shipped fraction.
    expect(SPLIT_MIN_PANE_PX - armPx).toBeCloseTo(105);
    expect(SPLIT_CLOSE_ARM_FRACTION).toBeLessThan(SPLIT_CLOSE_DISARM_FRACTION);
  });

  it("holds the warning through the hysteresis band, and drops it outside", () => {
    const between = ratioFor("primary", (armPx + disarmPx) / 2);
    expect(resolveSplitCloseArm({ ...base, ratio: between })).toBeNull();
    expect(resolveSplitCloseArm({ ...base, ratio: between, armed: "primary" })).toBe("primary");
    // Back inside the wider threshold: the warning goes, and so does the close.
    expect(
      resolveSplitCloseArm({
        ...base,
        ratio: ratioFor("primary", disarmPx + 1),
        armed: "primary",
      }),
    ).toBeNull();
  });

  it("never arms the left pane while the right one is still the picker", () => {
    const pickerBase = { ...base, hasSecondary: false };
    for (const ratio of [0.19, 0.1, 0, -0.4]) {
      expect(resolveSplitCloseArm({ ...pickerBase, ratio })).toBeNull();
    }
    // The picker itself is still dismissable — that pane holds nothing to keep.
    expect(resolveSplitCloseArm({ ...pickerBase, ratio: 0.9 })).toBe("secondary");
  });

  it("declines to arm on a container it cannot reason about", () => {
    expect(resolveSplitCloseArm({ ...base, ratio: Number.NaN })).toBeNull();
    expect(
      resolveSplitCloseArm({ ...base, ratio: 0.05, containerWidth: EXACT_FIT - 1 }),
    ).toBeNull();
  });

  /**
   * The outcome gate: you keep the thread you did not crush. Swapping these
   * two arms leaves the user staring at the pane they just shoved off screen.
   */
  it("keeps the thread the user did not crush", () => {
    const survivor = (closingPane: SplitPaneId, hasSecondary: boolean) =>
      resolveSplitCloseAction({ closingPane, hasSecondary }) === "promote-secondary"
        ? "second-thread"
        : "route-thread";

    expect(survivor("secondary", true)).toBe("route-thread");
    expect(survivor("primary", true)).toBe("second-thread");
    // Nothing to promote: the split just closes and the route stands.
    expect(survivor("primary", false)).toBe("route-thread");
  });

  describe("release", () => {
    /**
     * The cancel gate. Releasing with nothing armed must commit a width and
     * close nothing at all — an implementation that closes on "the pointer was
     * once past the threshold" rather than on "it is past it now" fails here.
     */
    it("commits a clamped ratio when nothing is armed", () => {
      const release = resolveSplitDragRelease({
        closing: null,
        pendingRatio: 0.05,
        containerWidth: width,
      });
      expect(release.kind).toBe("commit");
      expect(release).toEqual({ kind: "commit", ratio: splitRatioBounds(width).min });
    });

    it("closes the armed pane and commits nothing", () => {
      const release = resolveSplitDragRelease({
        closing: "secondary",
        pendingRatio: splitRatioBounds(width).max,
        containerWidth: width,
      });
      expect(release).toEqual({ kind: "close", pane: "secondary" });
      expect(release).not.toHaveProperty("ratio");
    });
  });

  /**
   * The gesture end to end, over exactly the functions the pointer handler
   * calls: shove left past the threshold, change your mind, let go. The split
   * must survive, and the ratio it keeps must be a sane one.
   */
  it("survives a shove the user backs out of", () => {
    const startRatio = SPLIT_DEFAULT_RATIO;
    const track = [0.4, 0.25, 0.15, 0.1, 0.24, startRatio];
    let armed: SplitPaneId | null = null;
    let pending = startRatio;
    const armedAt: Array<SplitPaneId | null> = [];
    for (const projected of track) {
      pending = clampSplitRatio(projected, width);
      armed = resolveSplitCloseArm({
        ratio: projected,
        containerWidth: width,
        hasSecondary: true,
        armed,
      });
      armedAt.push(armed);
    }

    expect(armedAt).toEqual([null, null, "primary", "primary", null, null]);
    const release = resolveSplitDragRelease({
      closing: armed,
      pendingRatio: pending,
      containerWidth: width,
    });
    expect(release).toEqual({ kind: "commit", ratio: startRatio });
  });
});

describe("splitGridTemplate", () => {
  it("spends the whole track on the two panes plus the divider", () => {
    expect(splitGridTemplate(0.35)).toBe(`0.35fr ${SPLIT_DIVIDER_PX}px 0.65fr`);
  });
});

describe("resolvePendingUserInputDigitSelection", () => {
  const base = {
    ownsKeyboard: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    key: "2",
    isEditableTarget: false,
    optionCount: 3,
  };

  it("selects the matching option", () => {
    expect(resolvePendingUserInputDigitSelection(base)).toBe(1);
  });

  it("ignores modified keys, editable targets and out-of-range digits", () => {
    expect(resolvePendingUserInputDigitSelection({ ...base, metaKey: true })).toBeNull();
    expect(resolvePendingUserInputDigitSelection({ ...base, isEditableTarget: true })).toBeNull();
    expect(resolvePendingUserInputDigitSelection({ ...base, key: "9" })).toBeNull();
    expect(resolvePendingUserInputDigitSelection({ ...base, key: "0" })).toBeNull();
    expect(resolvePendingUserInputDigitSelection({ ...base, key: "a" })).toBeNull();
  });

  /**
   * The failure this whole phase exists to prevent: two agents, both waiting
   * on a question, one keypress. Deleting the `ownsKeyboard` check in
   * `resolvePendingUserInputDigitSelection` makes both panes answer and fails
   * this test.
   */
  it("answers exactly one agent when both panes are waiting", () => {
    const keyboardOwner = resolveKeyboardOwner({
      renderState: "split",
      focusedPane: "secondary",
    });
    const answered = (["primary", "secondary"] as const)
      .map((paneId) => ({
        paneId,
        selection: resolvePendingUserInputDigitSelection({
          ...base,
          ownsKeyboard: paneOwnsKeyboard({ paneId, keyboardOwner }),
        }),
      }))
      .filter((pane) => pane.selection !== null);

    expect(answered).toHaveLength(1);
    expect(answered[0]?.paneId).toBe("secondary");
    expect(answered[0]?.selection).toBe(1);
  });

  it("still answers the only agent there is when the split is off", () => {
    const keyboardOwner = resolveKeyboardOwner({ renderState: "off", focusedPane: "primary" });
    expect(
      resolvePendingUserInputDigitSelection({
        ...base,
        ownsKeyboard: paneOwnsKeyboard({ paneId: null, keyboardOwner }),
      }),
    ).toBe(1);
  });
});
