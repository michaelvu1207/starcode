/**
 * Where the sky sits when you open a project.
 *
 * `/projects/$slug` is two `flex-1` siblings in a column below `xl` and a row
 * above it. In the column the orchestrator pane was first, so a project that
 * names one opened with the map in the lower half — on screen, but read second
 * and the first thing to clip. Flex order is undecidable from markup, the same
 * way `position: sticky` is, so this reads the source; see
 * `../sidebar/ChatsDock.layout.test.ts` for the precedent and its limits.
 *
 * What is *not* asserted here, because it is already unconditional: that the
 * star map renders at all. It has no disclosure, no toggle and no hover gate —
 * it is in the tree on every render of this view, and the only thing this file
 * is about is which half of the column it lands in.
 */
import { describe, expect, it } from "vite-plus/test";

import homeSource from "./ProjectHomeView.tsx?raw";

/** The block that draws the sky, from its wrapper to the component inside it. */
const skyBlock =
  homeSource.split("<div").find((block) => block.includes('data-testid="project-home-sky"')) ?? "";
/** The orchestrator pane's own class list, identified by the width only it has. */
const masterClassLine = homeSource.split("\n").find((line) => line.includes("xl:w-[30rem]")) ?? "";

describe("the project home's sky", () => {
  it("leads the column on the viewports where the column exists", () => {
    // Below `xl` the two panes stack, and this is the class that decides which
    // one you see first. Its absence is the regression: no error, no missing
    // element, the map simply moves under the orchestrator.
    expect(skyBlock).toContain("max-xl:order-first");
  });

  it("returns to source order once the layout is a row", () => {
    // At `xl` the orchestrator is a fixed 30rem column on the left and the sky
    // takes the rest — the Workbench's own shape, which ordering must not
    // rearrange into an orchestrator on the right.
    expect(skyBlock).toContain("xl:order-none");
  });

  it("leaves the orchestrator pane's own default alone", () => {
    // The fix is ordering, not closing. A project that designates an
    // orchestrator still opens with the pane; it just stops being the thing the
    // map is underneath. `showMaster` staying as it was is the whole claim.
    expect(homeSource).toContain("const showMaster = masterPaneOpen ?? designated !== null;");
    // Only one of the two siblings carries an order, which is what keeps the
    // rule readable: the sky moves, everything else stays where it was written.
    expect(masterClassLine).toContain("xl:flex-none");
    // Anchored to a class boundary rather than matched as a substring: this
    // line is full of `border-…`, which contains "order-" and made the naive
    // version of this assertion fail on correct code.
    expect(masterClassLine).not.toMatch(/(?:^|[\s:"])order-/);
  });

  it("keeps both panes able to shrink, so neither pushes the other off", () => {
    // `min-h-0` on a flex child is what lets it shrink below its content. Without
    // it on the sky, its 340px floor would win the split and clip the pane above
    // rather than sharing the column with it.
    expect(skyBlock).toContain("min-h-0");
    expect(skyBlock).toContain("flex-1");
  });
});
