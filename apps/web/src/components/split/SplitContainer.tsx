/**
 * Fork-owned: the split layout, mounted by the thread route.
 *
 * The route stays the primary pane's identity — `/$environmentId/$threadId`
 * is untouched — and this wraps it. With the split off it renders its
 * children and nothing else, so the single-pane app pays one component and no
 * pane context at all.
 *
 * It is also the one place that resolves what the split *actually* is once
 * the viewport has had its say, and publishes that to the store so keyboard
 * handlers can read the owner synchronously.
 *
 * @module SplitContainer
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useIsMobile } from "../../hooks/useMediaQuery";
import { resolveSplitRenderState, splitGridTemplate, clampSplitRatio } from "./Split.logic";
import { SplitDivider } from "./SplitDivider";
import { SplitPaneProvider } from "./SplitPaneContext";
import { SplitSecondaryPane } from "./SplitSecondaryPane";
import { useResizableRatio } from "./useResizableRatio";
import { useSplitStore } from "./splitStore";

import "./SplitPane.css";

const PANE_CLASS = "sc-split-pane flex min-h-0 min-w-0 flex-col overflow-hidden";

export function SplitContainer({ children }: { readonly children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  const enabled = useSplitStore((state) => state.enabled);
  const hasSecondary = useSplitStore((state) => state.secondary !== null);
  const storedRatio = useSplitStore((state) => state.ratio);
  const setRenderState = useSplitStore((state) => state.setRenderState);
  const isMobile = useIsMobile();

  // Measured rather than assumed: the sidebar can be collapsed, and the
  // window resized, without the media query changing.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    setContainerWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const renderState = resolveSplitRenderState({
    enabled,
    hasSecondary,
    isMobile,
    containerWidth,
  });

  useEffect(() => {
    setRenderState(renderState, containerWidth);
  }, [containerWidth, renderState, setRenderState]);

  // Leaving the split entirely resets ownership, so a stale `focusedPane`
  // cannot strand the keyboard in a pane that is no longer on screen.
  useEffect(() => {
    if (renderState !== "off") return;
    if (useSplitStore.getState().focusedPane === "primary") return;
    useSplitStore.getState().focusPane("primary");
  }, [renderState]);

  const { ratio, dragging, handlers } = useResizableRatio({
    containerRef,
    ratio: clampSplitRatio(storedRatio, containerWidth),
  });

  if (renderState === "off") {
    return (
      <div ref={containerRef} className="sc-split-container flex min-h-0 min-w-0 flex-1">
        {children}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-split-live="true"
      data-testid="split-container"
      className="sc-split-container grid min-h-0 min-w-0 flex-1"
      style={{ gridTemplateColumns: splitGridTemplate(ratio) }}
    >
      <SplitPaneProvider paneId="primary" className={PANE_CLASS}>
        {children}
      </SplitPaneProvider>
      <SplitDivider
        ratio={ratio}
        dragging={dragging}
        handlers={handlers}
        containerRef={containerRef}
      />
      <SplitPaneProvider paneId="secondary" className={PANE_CLASS}>
        <SplitSecondaryPane />
      </SplitPaneProvider>
    </div>
  );
}
