/**
 * The thread pane draws nothing, enforced.
 *
 * `starcode-theme.css` section 4c puts the pane's tint on L1, which is
 * `[data-slot="sidebar-inset"]` and nothing below it. The theme lets the sky
 * through one more level with `[data-slot="sidebar-inset"] > .bg-background`,
 * but that `>` is a direct-child selector, so it only ever reaches a route body
 * mounted immediately inside the inset.
 *
 * `ChatView` is not mounted that way. The thread route wraps it in
 * `SplitContainer`, and three other surfaces embed it deeper still. When the
 * split wrapper landed, `ChatView`'s root — which carried `bg-background` —
 * dropped out of the selector's reach and became an opaque `--sc-ink-900` plate
 * over the sky. The visible symptom was that a thread's background went black
 * the moment its first message was sent, because composing happens on the draft
 * route, where the root *was* still a direct child.
 *
 * A component test cannot hold this: nothing renders wrong in isolation, and
 * the way it breaks is a wrapper being inserted somewhere else entirely. So the
 * rule is asserted against the sources of the chain itself.
 *
 * Scoped to these files rather than swept app-wide because a full-size opaque
 * fill is correct in plenty of other places — L3 islands like
 * `PreviewPanelShell`, and the route bodies that really are direct children of
 * the inset. Inside this chain it is never correct: an island mounted here
 * should carry its own fill in a shell component, the way the right panel does.
 *
 * Sources come through Vite's `?raw`, the way `starcodeEngraving.test` reads
 * component sources — not `node:fs`, which the repo's Effect lint bans.
 */
import { describe, expect, it } from "vite-plus/test";

const SOURCES = import.meta.glob<string>("./**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * `ChatView` and everything between it and the inset that owns the tint. Each
 * one is a pane interior or a pane wrapper, so none of them may paint.
 */
const PANE_CHAIN = [
  "./ChatView.tsx",
  "./split/SplitContainer.tsx",
  "./split/SplitSecondaryPane.tsx",
  "./workbench/WorkbenchMasterPane.tsx",
  "./projects/ProjectHomeView.tsx",
];

/** `bg-background` itself, never `bg-background/70` — a tint is not a plate. */
const OPAQUE_FILL = /\bbg-background(?![\w/-])/;

/** Only a full-size box can occlude the sky; a chip or a button cannot. */
const FULL_SIZE = /\bflex-1\b/;

describe("the thread pane", () => {
  it("mounts every ChatView wrapper this test knows about", () => {
    // Without this the list could silently rot into an assertion about nothing
    // — a renamed or moved file would just stop being checked.
    for (const path of PANE_CHAIN) {
      expect(SOURCES[path], `${path} is missing — update PANE_CHAIN`).toBeDefined();
    }
  });

  it("paints no full-size fill anywhere between the inset and the transcript", () => {
    // Per class literal rather than per element: a root's classes can be split
    // across a `cn()` call, so this catches the single-literal case that has
    // actually occurred and leaves the split-literal case to review.
    const plates = PANE_CHAIN.flatMap((path) =>
      (SOURCES[path]?.match(/"[^"\n]*"/g) ?? [])
        .filter((literal) => FULL_SIZE.test(literal) && OPAQUE_FILL.test(literal))
        .map((literal) => `${path}: ${literal}`),
    );

    expect(plates).toEqual([]);
  });
});
