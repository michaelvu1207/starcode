/**
 * What the project home is allowed to be.
 *
 * F16.6 cut this view down to a chat, a map, and a name. The cut is the feature,
 * so the regression to guard is chrome growing back — a header strip, a rollup
 * row, a thread rail — and that is invisible to a rendering test, which would
 * happily pass with a second toolbar above the composer. So this reads the
 * source, the same way `../sidebar/SidebarChatMode.layout.test.ts` does, and with the
 * same limits: it asserts what the markup says, not what the browser draws.
 *
 * Flex order and column widths are here for the older reason too — both are
 * undecidable from a rendered tree without layout.
 */
import { describe, expect, it } from "vite-plus/test";

import homeSource from "./ProjectHomeView.tsx?raw";

/** The block that draws the sky, from its wrapper to the component inside it. */
const skyBlock =
  homeSource.split("<div").find((block) => block.includes('data-testid="project-home-sky"')) ?? "";
/** The block that holds the orchestrator's chat. */
const chatBlock =
  homeSource.split("<div").find((block) => block.includes('data-testid="project-home-chat"')) ?? "";

describe("the project home's two panes", () => {
  it("gives the chat the page and the map the right side of it", () => {
    // The chat takes what is left after the map's column, which is what makes
    // it read as a thread view rather than as a third of one.
    expect(chatBlock).toContain("flex-1");
    expect(chatBlock).toContain("min-w-0");
    expect(skyBlock).toContain("xl:w-[34rem]");
    expect(skyBlock).toContain("xl:flex-none");
  });

  it("keeps the map visible when the layout is a column", () => {
    // Below `xl` the panes stack, and the map has to claim half the height
    // rather than being pushed off the bottom by a chat that grows.
    expect(skyBlock).toContain("max-xl:flex-1");
    expect(skyBlock).toContain("min-h-0");
  });

  it("renders the orchestrator as a chat, not as a pane with a header", () => {
    // `WorkbenchMasterChat` is ChatView plus a readiness gate. `WorkbenchMasterPane`
    // is that plus the Master/Change/Clear strip this view exists without.
    // The element, not the name: the chat is imported from the pane's own
    // module, so a bare substring match would find the import path.
    expect(homeSource).toContain("<WorkbenchMasterChat");
    expect(homeSource).not.toContain("<WorkbenchMasterPane");
  });

  it("offers a way out when the designated orchestrator is gone", () => {
    // A project whose master thread was deleted must not be a dead pane: the
    // start state comes back, so another thread can be named.
    expect(homeSource).toContain("missingFallback={start}");
  });

  it("keeps the header to a mark and a name", () => {
    const header = homeSource.slice(homeSource.indexOf("<header"), homeSource.indexOf("</header>"));
    expect(header).toContain("ProjectGlyph");
    expect(header).toContain("project.display.title");
    // The strip Michael cut. Naming the labels rather than the components,
    // because the regression is a button reappearing under any implementation.
    for (const gone of ["Archive", "Delete", "Edit", "Orchestrator"]) {
      expect(header).not.toContain(gone);
    }
  });

  it("has no rollup row, no machine chips and no thread rail", () => {
    // Each of these was a whole region of the old header or body. They are not
    // hidden behind a toggle — they are gone, and the imports that fed them
    // with them.
    expect(homeSource).not.toContain("foldProjectFeatures");
    expect(homeSource).not.toContain("project-feature-rollup");
    expect(homeSource).not.toContain("<aside");
    expect(homeSource).not.toContain("ProjectDeleteDialog");
    expect(homeSource).not.toContain("ProjectEditDialog");
  });
});
