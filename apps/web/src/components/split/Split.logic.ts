/**
 * Fork-owned: every decision split view makes, with no React and no DOM.
 *
 * The load-bearing one is `paneOwnsKeyboard`. Two mounted `ChatView`s each
 * register their own window/document key handlers, so without an owner a
 * single keypress is answered twice — and for the digit shortcuts that answer
 * an agent's question, twice is irreversible. Every gated call site resolves
 * against this module, and `resolveKeyboardOwner` returns `"primary"` for
 * every state that is not a live two-pane split, which is what makes the
 * single-pane app provably unchanged.
 *
 * @module Split.logic
 */

export type SplitPaneId = "primary" | "secondary";

/**
 * A transcript plus its composer stops being usable below this. The preview
 * panel uses 360px, but it carries a URL bar and a page, not a message list
 * with inline diffs and a multi-line editor.
 */
export const SPLIT_MIN_PANE_PX = 420;

/** Divider track width in the grid template. */
export const SPLIT_DIVIDER_PX = 6;

export const SPLIT_DEFAULT_RATIO = 0.5;

/** Arrow-key nudge, and its shifted coarse step. */
export const SPLIT_RATIO_KEY_STEP = 0.02;
export const SPLIT_RATIO_KEY_STEP_COARSE = 0.1;

export const SPLIT_STORAGE_KEY = "t3code:split-view:v1";

/**
 * Render state of the split, resolved from the store plus the live viewport.
 *
 * - `off` — one pane, exactly as before the feature existed.
 * - `picking` — split is open but nothing is chosen yet, so the right pane
 *   shows the thread picker. There is no second `ChatView` mounted.
 * - `split` — two `ChatView`s. The only state with a keyboard-ownership
 *   question to answer.
 */
export type SplitRenderState = "off" | "picking" | "split";

function availableWidth(containerWidth: number): number {
  return containerWidth - SPLIT_DIVIDER_PX;
}

/** Whether two panes both clear the minimum at this container width. */
export function splitFitsContainer(containerWidth: number): boolean {
  if (!Number.isFinite(containerWidth)) return false;
  return availableWidth(containerWidth) >= SPLIT_MIN_PANE_PX * 2;
}

/**
 * Ratio bounds for the given container. Expressed as a ratio rather than a
 * pixel clamp so the limit tightens on its own as the window narrows.
 */
export function splitRatioBounds(containerWidth: number): {
  readonly min: number;
  readonly max: number;
} {
  if (!splitFitsContainer(containerWidth)) {
    return { min: SPLIT_DEFAULT_RATIO, max: SPLIT_DEFAULT_RATIO };
  }
  const min = SPLIT_MIN_PANE_PX / availableWidth(containerWidth);
  return { min, max: 1 - min };
}

/**
 * Clamp a ratio against the live container. `containerWidth` of `null` means
 * "not measured yet" — the value is passed through so a stored ratio is not
 * flattened to 50/50 on the first frame.
 */
export function clampSplitRatio(ratio: number, containerWidth: number | null): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT_RATIO;
  if (containerWidth === null) return Math.min(1, Math.max(0, ratio));
  const { min, max } = splitRatioBounds(containerWidth);
  return Math.min(max, Math.max(min, ratio));
}

export function resolveSplitRenderState(input: {
  readonly enabled: boolean;
  readonly hasSecondary: boolean;
  readonly isMobile: boolean;
  /** `null` until the container has been measured. */
  readonly containerWidth: number | null;
}): SplitRenderState {
  if (!input.enabled) return "off";
  // Below `max-md` the primary renders alone. The store keeps its value, so
  // the split comes back when the window does.
  if (input.isMobile) return "off";
  if (input.containerWidth !== null && !splitFitsContainer(input.containerWidth)) return "off";
  return input.hasSecondary ? "split" : "picking";
}

/**
 * Which pane a keypress belongs to.
 *
 * Anything short of a live two-pane split answers `"primary"`, so the gate
 * below is a no-op for every user who never opens the feature.
 */
export function resolveKeyboardOwner(input: {
  readonly renderState: SplitRenderState;
  readonly focusedPane: SplitPaneId;
}): SplitPaneId {
  return input.renderState === "split" ? input.focusedPane : "primary";
}

/**
 * The gate. `paneId` is `null` for anything rendered outside a split pane —
 * the command palette, the sidebar, the single-pane route — and those always
 * own the keyboard.
 */
export function paneOwnsKeyboard(input: {
  readonly paneId: SplitPaneId | null;
  readonly keyboardOwner: SplitPaneId;
}): boolean {
  return input.paneId === null || input.paneId === input.keyboardOwner;
}

/**
 * Where a sidebar thread click lands. The pane you last touched fills — the
 * same model as every editor split, and no new concept to learn. A freshly
 * opened split focuses its empty pane, so the first click after opening lands
 * there without a separate affordance.
 *
 * `hasRouteThread` is the load-bearing one, and it is not an optimisation.
 * `renderState` and `focusedPane` are *published by a mounted*
 * `SplitContainer`, which only the thread route mounts — so on the project
 * home, the workbench, the projects index or a draft, the newest values
 * describe a split the user walked away from. Answering `"secondary"` there
 * puts the thread in a pane nothing is drawing, and the click reads as a
 * sidebar that has stopped working. The route's own answer to "is there a
 * left pane" cannot go stale, so it is asked first.
 */
export function resolveSidebarOpenTarget(input: {
  /**
   * Whether the route is showing a thread — the same condition under which
   * `SplitContainer` is mounted. See `resolveOpenInSplitState`, which keys the
   * row menu's entry on exactly this fact.
   */
  readonly hasRouteThread: boolean;
  readonly renderState: SplitRenderState;
  readonly focusedPane: SplitPaneId;
}): "navigate" | "secondary" {
  if (!input.hasRouteThread) return "navigate";
  if (input.renderState === "off") return "navigate";
  return input.focusedPane === "secondary" ? "secondary" : "navigate";
}

/**
 * Keyboard resize for the divider. Element-scoped, so it is immune to the
 * ownership problem the rest of this module exists for.
 */
export function nextRatioForKey(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ratio: number;
  readonly containerWidth: number | null;
}): number | null {
  const step = input.shiftKey ? SPLIT_RATIO_KEY_STEP_COARSE : SPLIT_RATIO_KEY_STEP;
  const bounds =
    input.containerWidth === null ? { min: 0, max: 1 } : splitRatioBounds(input.containerWidth);

  switch (input.key) {
    case "ArrowLeft":
      return clampSplitRatio(input.ratio - step, input.containerWidth);
    case "ArrowRight":
      return clampSplitRatio(input.ratio + step, input.containerWidth);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    case "Enter":
    case " ":
      return clampSplitRatio(SPLIT_DEFAULT_RATIO, input.containerWidth);
    default:
      return null;
  }
}

/** Grid template for the split container. */
export function splitGridTemplate(ratio: number): string {
  return `${ratio}fr ${SPLIT_DIVIDER_PX}px ${1 - ratio}fr`;
}

/**
 * The digit shortcut that answers an agent's pending question, decided
 * without a DOM.
 *
 * This is the one handler where a missing ownership check is not recoverable:
 * both agents receive the answer and both act on it. The decision lives here,
 * whole, so a two-pane case can be asserted in a unit test rather than only
 * in a browser.
 *
 * Returns the zero-based option index to select, or `null` to ignore the key.
 */
export function resolvePendingUserInputDigitSelection(input: {
  readonly ownsKeyboard: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly key: string;
  /** Caller-computed: focus is in an input, textarea or contenteditable. */
  readonly isEditableTarget: boolean;
  readonly optionCount: number;
}): number | null {
  if (!input.ownsKeyboard) return null;
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.isEditableTarget) return null;
  const digit = Number.parseInt(input.key, 10);
  if (Number.isNaN(digit) || digit < 1 || digit > 9) return null;
  const optionIndex = digit - 1;
  if (optionIndex >= input.optionCount) return null;
  return optionIndex;
}
