import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SplitDivider } from "./SplitDivider";

const noopHandlers = {
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
};

describe("SplitDivider", () => {
  // The handle it is modelled on wears `role="separator"` with no tabIndex,
  // no value and no key handling — a mouse-only control in an ARIA costume.
  it("is reachable by keyboard and reports where it is", () => {
    const markup = renderToStaticMarkup(
      <SplitDivider
        ratio={0.35}
        dragging={false}
        handlers={noopHandlers}
        containerRef={createRef<HTMLElement>()}
      />,
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-valuenow="35"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain("35% to the left pane");
  });

  it("names the pane an overdrag would close, and says so only then", () => {
    const idle = renderToStaticMarkup(
      <SplitDivider
        ratio={0.5}
        dragging
        handlers={noopHandlers}
        containerRef={createRef<HTMLElement>()}
      />,
    );
    expect(idle).toContain('data-closing="none"');

    const armed = renderToStaticMarkup(
      <SplitDivider
        ratio={0.27}
        dragging
        closingPane="primary"
        handlers={noopHandlers}
        containerRef={createRef<HTMLElement>()}
      />,
    );
    expect(armed).toContain('data-closing="primary"');
  });

  it("says when it is being dragged, so styling never guesses", () => {
    const dragging = renderToStaticMarkup(
      <SplitDivider
        ratio={0.5}
        dragging
        handlers={noopHandlers}
        containerRef={createRef<HTMLElement>()}
      />,
    );
    expect(dragging).toContain('data-dragging="true"');
  });
});
