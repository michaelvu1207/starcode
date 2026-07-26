/**
 * The engraving vocabulary's one hard rule, enforced.
 *
 * `starcode-theme.css` section 7 states it plainly: the marks never go on rows,
 * list items, or anything that repeats, because a flourish that fires a hundred
 * times an hour has stopped being a flourish. That is a rule about the whole
 * app rather than about any one component, so no component test can hold it —
 * the way it gets broken is by a later change adding a fourth mark, then a
 * tenth, each of which looks reasonable on its own.
 *
 * The budget below is a budget, not a fact about today. Raising it should take
 * a moment's thought about whether the new mark repeats.
 *
 * Sources come through Vite's `?raw`, the way `reactGrabBoundary.test` reads
 * `main.tsx` — not `node:fs`, which the repo's Effect lint bans outright.
 * ⚠️ `?raw` works for `.tsx` and NOT for `.css`: Vite's CSS plugin claims the
 * import and hands back an empty string in the test environment, so the theme
 * file's own contents cannot be asserted from here at all.
 */
import { describe, expect, it } from "vite-plus/test";

/** Every component source, so the sweep cannot miss a file nobody thought of. */
const COMPONENT_SOURCES = import.meta.glob<string>("./**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** How many places in the whole app may wear an engraved section mark. */
const ENGRAVING_BUDGET = 6;

describe("the engraving vocabulary", () => {
  it("stays rare — the marks are never on anything that repeats", () => {
    const wearers = Object.entries(COMPONENT_SOURCES).flatMap(([path, source]) =>
      source
        .split("\n")
        .filter((line) => /starcode-section-(head|rule)\b/.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );

    // Both halves matter: zero would mean the glob silently stopped matching
    // and this test had quietly become an assertion about nothing.
    expect(wearers.length).toBeGreaterThan(0);
    expect(wearers.length).toBeLessThanOrEqual(ENGRAVING_BUDGET);
  });

  it("puts an engraved mark on neither a project group nor a thread row", () => {
    // The two surfaces in this app that repeat per item, named explicitly
    // because they are the two a later change is most likely to reach for.
    const perItem = ["./components/sidebar/SidebarThreadRow.tsx"];
    for (const path of perItem) {
      expect(COMPONENT_SOURCES[path]).toBeDefined();
      expect(COMPONENT_SOURCES[path]).not.toMatch(/starcode-section-(head|rule)\b/);
    }
    // The projects view holds both the two allowed marks and the repeating
    // group header, so it is checked by count rather than by absence: two is
    // the section headings, more than two means one landed on a group.
    const projectsView = COMPONENT_SOURCES["./components/sidebar/SidebarProjectsView.tsx"];
    expect(projectsView).toBeDefined();
    expect(projectsView?.match(/starcode-section-rule\b/g) ?? []).toHaveLength(2);
  });
});
