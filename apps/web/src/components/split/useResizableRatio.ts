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
 * @module useResizableRatio
 */
import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { clampSplitRatio } from "./Split.logic";
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
}): {
  /** What the grid should render: the live ratio mid-drag, else the store's. */
  readonly ratio: number;
  readonly dragging: boolean;
  readonly handlers: ResizableRatioHandlers;
} {
  const { containerRef, ratio: committedRatio } = input;
  const setRatio = useSplitStore((state) => state.setRatio);
  const [liveRatio, setLiveRatio] = useState<number | null>(null);

  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startRatio: number;
    containerWidth: number;
    pending: number;
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
        rafId: null,
        target,
      };
      setLiveRatio(committedRatio);
    },
    [committedRatio, containerRef],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = (event.clientX - state.startX) / state.containerWidth;
    state.pending = clampSplitRatio(state.startRatio + delta, state.containerWidth);
    if (state.rafId !== null) return;
    state.rafId = requestAnimationFrame(() => {
      const active = dragStateRef.current;
      if (!active) return;
      active.rafId = null;
      setLiveRatio(active.pending);
    });
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const finalRatio = clampSplitRatio(state.pending, state.containerWidth);
      releasePointer(event.pointerId);
      setLiveRatio(null);
      setRatio(finalRatio);
    },
    [releasePointer, setRatio],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      // Don't commit a cancelled drag; revert to where it started.
      releasePointer(event.pointerId);
      setLiveRatio(null);
    },
    [releasePointer],
  );

  return {
    ratio: liveRatio ?? committedRatio,
    dragging: liveRatio !== null,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
