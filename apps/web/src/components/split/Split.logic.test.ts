import { describe, expect, it } from "vite-plus/test";

import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_DIVIDER_PX,
  SPLIT_MIN_PANE_PX,
  clampSplitRatio,
  nextRatioForKey,
  paneOwnsKeyboard,
  resolveKeyboardOwner,
  resolvePendingUserInputDigitSelection,
  resolveSidebarOpenTarget,
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
    expect(resolveSidebarOpenTarget({ renderState: "off", focusedPane: "secondary" })).toBe(
      "navigate",
    );
  });

  it("fills the second pane while it is the focused one", () => {
    expect(resolveSidebarOpenTarget({ renderState: "picking", focusedPane: "secondary" })).toBe(
      "secondary",
    );
    expect(resolveSidebarOpenTarget({ renderState: "split", focusedPane: "secondary" })).toBe(
      "secondary",
    );
  });

  it("navigates when the primary pane is focused", () => {
    expect(resolveSidebarOpenTarget({ renderState: "split", focusedPane: "primary" })).toBe(
      "navigate",
    );
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
