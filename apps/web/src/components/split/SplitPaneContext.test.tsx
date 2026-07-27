import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SplitPaneProvider } from "./SplitPaneContext";

describe("SplitPaneProvider", () => {
  it("paints nothing over a pane that is not about to close", () => {
    const markup = renderToStaticMarkup(
      <SplitPaneProvider paneId="secondary">
        <p>transcript</p>
      </SplitPaneProvider>,
    );
    expect(markup).toContain('data-split-pane-closing="false"');
    expect(markup).not.toContain("sc-split-pane-scrim");
  });

  // The warning has to be readable *before* the release, or the gesture is
  // just a pane vanishing under your hand.
  it("scrims the doomed pane and says what letting go does", () => {
    const markup = renderToStaticMarkup(
      <SplitPaneProvider paneId="secondary" closing>
        <p>transcript</p>
      </SplitPaneProvider>,
    );
    expect(markup).toContain('data-split-pane-closing="true"');
    expect(markup).toContain('data-testid="split-scrim-secondary"');
    expect(markup).toContain("Release to close this pane");
    // The transcript stays mounted under it: a cancelled drag must put the
    // pane back, not rebuild it.
    expect(markup).toContain("<p>transcript</p>");
  });
});
