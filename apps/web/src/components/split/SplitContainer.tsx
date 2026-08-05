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
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useIsMobile } from "../../hooks/useMediaQuery";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  resolveSplitCloseAction,
  resolveSplitRenderState,
  splitGridTemplate,
  clampSplitRatio,
  type SplitPaneId,
} from "./Split.logic";
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

  // The published state describes a split that is *on screen*, so it has to
  // go when this does. The thread route mounts the container and the other
  // routes do not, so leaving a live split for the project home or the
  // workbench used to strand `renderState: "split"` with the second pane
  // still focused — and the sidebar, which asks that state where a click
  // should land, kept answering "the second pane" on a route that had none.
  useEffect(() => () => useSplitStore.getState().releaseContainer(), []);

  // Leaving the split entirely resets ownership, so a stale `focusedPane`
  // cannot strand the keyboard in a pane that is no longer on screen.
  useEffect(() => {
    if (renderState !== "off") return;
    if (useSplitStore.getState().focusedPane === "primary") return;
    useSplitStore.getState().focusPane("primary");
  }, [renderState]);

  // Dragging a pane past its clamp dismisses it. The pane that survives is
  // the one the user did not crush — which for the left pane means the route
  // has to follow the second thread, because the route *is* the left pane's
  // identity and closing without moving it would keep the wrong thread.
  const navigate = useNavigate();
  const closePaneFromDrag = useCallback(
    (pane: SplitPaneId) => {
      const state = useSplitStore.getState();
      const secondary = state.secondary;
      const action = resolveSplitCloseAction({
        closingPane: pane,
        hasSecondary: secondary !== null,
      });
      if (action === "promote-secondary" && secondary !== null) {
        state.setSecondary(null);
        state.closeSplit();
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(secondary),
        });
        return;
      }
      state.closeSplit();
    },
    [navigate],
  );

  const { ratio, dragging, closingPane, handlers } = useResizableRatio({
    containerRef,
    ratio: clampSplitRatio(storedRatio, containerWidth),
    hasSecondary,
    onDragClose: closePaneFromDrag,
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
      <SplitPaneProvider
        paneId="primary"
        className={PANE_CLASS}
        closing={closingPane === "primary"}
      >
        {children}
      </SplitPaneProvider>
      <SplitDivider
        ratio={ratio}
        dragging={dragging}
        closingPane={closingPane}
        handlers={handlers}
        containerRef={containerRef}
      />
      <SplitPaneProvider
        paneId="secondary"
        className={PANE_CLASS}
        closing={closingPane === "secondary"}
      >
        <SplitSecondaryPane />
      </SplitPaneProvider>
    </div>
  );
}
