/**
 * Fork-owned: divider drag state, as a ratio rather than a width.
 *
 * Modelled line for line on `hooks/useResizableWidth.ts` — pointer capture,
 * rAF-throttled updates, commit once at drag-end rather than 60 times a
 * second, body cursor lock, cancel reverts to where the drag started. It is a
 * separate hook rather than a reuse for one reason: that one stores a pixel
 * width for a side-anchored panel, so resizing the OS window would pin the
 * left pane and let the right absorb the whole change. A split is a
 * proportion, so this stores 0..1 and measures the container per drag.
 *
 * The drag-end rule matters more here than it did there. The store is
 * persisted, so a per-frame commit would be ~60 localStorage writes a second
 * — and, worse, ~60 store notifications a second through two live `ChatView`
 * subscriptions. During a drag the ratio is local state that only the grid
 * template reads.
 *
 * The one thing it keeps that the pixel hook has no use for is the *unclamped*
 * projection of the pointer. Past the clamp the rendered ratio stops moving,
 * so it is the only value left that can tell an ordinary resize from someone
 * shoving a pane off the screen — which is the gesture that closes the split.
 *
 * @module useResizableRatio
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  clampSplitRatio,
  resolveSplitCloseArm,
  resolveSplitDragRelease,
  type SplitPaneId,
} from "./Split.logic";
import { useSplitStore } from "./splitStore";

export interface ResizableRatioHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function useResizableRatio(input: {
  readonly containerRef: RefObject<HTMLElement | null>;
  /** The committed ratio, from the store. */
  readonly ratio: number;
  /** Whether the second pane holds a thread, or is still the picker. */
  readonly hasSecondary: boolean;
  /**
   * Called on release from an armed drag, with the pane the user crushed.
   * Nothing is committed to the store on this path — the ratio the split had
   * before the gesture is the one it should come back with.
   */
  readonly onDragClose: (pane: SplitPaneId) => void;
}): {
  /** What the grid should render: the live ratio mid-drag, else the store's. */
  readonly ratio: number;
  readonly dragging: boolean;
  /** The pane releasing would dismiss right now, or `null`. */
  readonly closingPane: SplitPaneId | null;
  readonly handlers: ResizableRatioHandlers;
} {
  const { containerRef, ratio: committedRatio, hasSecondary, onDragClose } = input;
  const setRatio = useSplitStore((state) => state.setRatio);
  const [liveRatio, setLiveRatio] = useState<number | null>(null);
  const [closingPane, setClosingPane] = useState<SplitPaneId | null>(null);

  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startRatio: number;
    containerWidth: number;
    pending: number;
    /** Armed pane, tracked on the ref so hysteresis reads it without a render. */
    closing: SplitPaneId | null;
    hasSecondary: boolean;
    rafId: number | null;
    target: HTMLElement;
  } | null>(null);

  const releasePointer = useCallback((pointerId: number) => {
    const state = dragStateRef.current;
    if (!state) return;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
    }
    try {
      if (state.target.hasPointerCapture(pointerId)) {
        state.target.releasePointerCapture(pointerId);
      }
    } catch {
      // pointer may already be released; harmless.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    dragStateRef.current = null;
  }, []);

  /**
   * A drag ends on the pointer, so a container that goes away mid-drag ends
   * nothing at all: `col-resize` and `user-select: none` are set on
   * `document.body`, which outlives this hook, and no later event will arrive
   * to take them off. The result is a whole app that cannot select text and
   * shows a resize cursor everywhere, with nothing on screen to explain it.
   *
   * Unmounting is a real event in this folder now — `SplitContainer` releases
   * its published state the same way — so the locks come off here rather than
   * waiting for a `pointerup` that is never coming. Nothing is committed and
   * nothing closes: an interrupted drag is not a decision.
   */
  useEffect(
    () => () => {
      const state = dragStateRef.current;
      if (state !== null) releasePointer(state.pointerId);
    },
    [releasePointer],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
      if (containerWidth <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startRatio: committedRatio,
        containerWidth,
        pending: committedRatio,
        closing: null,
        hasSecondary,
        rafId: null,
        target,
      };
      setLiveRatio(committedRatio);
      setClosingPane(null);
    },
    [committedRatio, containerRef, hasSecondary],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = (event.clientX - state.startX) / state.containerWidth;
    const projected = state.startRatio + delta;
    // The clamped value is what the panes render; the raw projection is the
    // only thing that still knows how hard the pointer is pushing.
    state.pending = clampSplitRatio(projected, state.containerWidth);
    state.closing = resolveSplitCloseArm({
      ratio: projected,
      containerWidth: state.containerWidth,
      hasSecondary: state.hasSecondary,
      armed: state.closing,
    });
    if (state.rafId !== null) return;
    state.rafId = requestAnimationFrame(() => {
      const active = dragStateRef.current;
      if (!active) return;
      active.rafId = null;
      setLiveRatio(active.pending);
      setClosingPane(active.closing);
    });
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const release = resolveSplitDragRelease({
        closing: state.closing,
        pendingRatio: state.pending,
        containerWidth: state.containerWidth,
      });
      releasePointer(event.pointerId);
      setLiveRatio(null);
      setClosingPane(null);
      if (release.kind === "close") {
        onDragClose(release.pane);
        return;
      }
      setRatio(release.ratio);
    },
    [onDragClose, releasePointer, setRatio],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      // Don't commit a cancelled drag; revert to where it started. A cancel
      // never closes, however far past the clamp the pointer had travelled.
      releasePointer(event.pointerId);
      setLiveRatio(null);
      setClosingPane(null);
    },
    [releasePointer],
  );

  return {
    ratio: liveRatio ?? committedRatio,
    dragging: liveRatio !== null,
    closingPane,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
