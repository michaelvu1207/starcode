/**
 * Which mark a project wears.
 *
 * One component decides icon-versus-constellation for all six surfaces that
 * render it, so this is where that decision is pinned. The interesting parts
 * are the two that are invisible until they are wrong: a project with no icon
 * must still draw its figure (every project starts that way and most stay), and
 * an uploaded icon must escape the hue rotation its wrapper applies — that
 * filter exists to tint monochrome ink and would recolour a logo.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProjectGlyph } from "./ProjectGlyph";

const ICON = "data:image/webp;base64,UklGRiAAAABXRUJQ";

describe("ProjectGlyph", () => {
  it("draws the constellation when no icon is set", () => {
    const markup = renderToStaticMarkup(<ProjectGlyph slug="simcloud-platform" />);
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("<img");
  });

  it("draws the uploaded icon instead, when there is one", () => {
    const markup = renderToStaticMarkup(<ProjectGlyph slug="simcloud-platform" icon={ICON} />);
    expect(markup).toContain("<img");
    expect(markup).toContain(ICON);
    // The figure is gone, not layered underneath: two marks in one 16px box is
    // a smudge, and the icon is the operator's explicit answer to "which one".
    expect(markup).not.toContain("<svg");
  });

  it("leaves the accent's hue rotation to be undone on the wrapper", () => {
    // `.sc-project-mark` rotates hue to tint the engraved marks, and an
    // ancestor's filter applies to its whole subtree — so an `<img>` cannot
    // escape it from the inside. The first version tried `filter: none` on the
    // image and shipped a gold logo rendered green; the fix is
    // `.sc-project-mark:has(img)` in Projects.css. This pins the component's
    // half of that contract: it must not carry a filter of its own, because a
    // second one here would mask the wrapper rule the next time it regressed.
    const markup = renderToStaticMarkup(<ProjectGlyph slug="hub" icon={ICON} />);
    expect(markup).not.toContain("filter");
  });

  it("keeps the mark decorative, however it is drawn", () => {
    // Every call site renders this beside the project's own name, so a second
    // announcement of the same thing is noise to a screen reader.
    for (const markup of [
      renderToStaticMarkup(<ProjectGlyph slug="hub" />),
      renderToStaticMarkup(<ProjectGlyph slug="hub" icon={ICON} />),
    ]) {
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it("honours the chosen figure variant when there is no icon", () => {
    const derived = renderToStaticMarkup(<ProjectGlyph slug="hub" />);
    const chosen = renderToStaticMarkup(<ProjectGlyph slug="hub" variant="3" />);
    expect(chosen).not.toBe(derived);
    // …and an icon overrides both, so a project that picked a figure and then
    // uploaded a logo gets the logo.
    expect(renderToStaticMarkup(<ProjectGlyph slug="hub" variant="3" icon={ICON} />)).toContain(
      "<img",
    );
  });
});
