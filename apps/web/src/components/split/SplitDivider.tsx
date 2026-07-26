/**
 * Fork-owned: the bar between the two panes.
 *
 * The existing `RightPanelResizeHandle` could not be reused: it is
 * `absolute inset-y-0 -left-1`, positioning for a right-anchored panel, so it
 * cannot sit between two flex or grid children. It is also a `role="separator"`
 * with no `tabIndex`, no `aria-valuenow` and no key handling — a mouse-only
 * separator wearing a separator's ARIA role. This one is reachable by keyboard
 * and reports where it is.
 *
 * Its key handlers are element-scoped, so they are immune to the pane
 * ownership problem the rest of this folder exists for.
 *
 * @module SplitDivider
 */
import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import { nextRatioForKey } from "./Split.logic";
import { useSplitStore } from "./splitStore";
import type { ResizableRatioHandlers } from "./useResizableRatio";

export function SplitDivider({
  ratio,
  dragging,
  handlers,
  containerRef,
}: {
  readonly ratio: number;
  readonly dragging: boolean;
  readonly handlers: ResizableRatioHandlers;
  readonly containerRef: RefObject<HTMLElement | null>;
}) {
  const setRatio = useSplitStore((state) => state.setRatio);
  const resetRatio = useSplitStore((state) => state.resetRatio);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? null;
      const next = nextRatioForKey({
        key: event.key,
        shiftKey: event.shiftKey,
        ratio,
        containerWidth,
      });
      if (next === null) return;
      event.preventDefault();
      setRatio(next);
    },
    [containerRef, ratio, setRatio],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize split view"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(ratio * 100)}% to the left pane`}
      tabIndex={0}
      data-testid="split-divider"
      data-dragging={dragging ? "true" : "false"}
      className="sc-split-divider"
      onKeyDown={onKeyDown}
      // The only fast way back from a lopsided drag.
      onDoubleClick={resetRatio}
      {...handlers}
    />
  );
}
