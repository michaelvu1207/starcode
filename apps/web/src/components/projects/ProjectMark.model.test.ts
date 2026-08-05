import { describe, expect, it } from "vite-plus/test";

import {
  projectAccentHue,
  projectGlyph,
  projectGlyphSeed,
  PROJECT_ACCENTS,
  PROJECT_GLYPH_VARIANTS,
} from "./ProjectMark.model";

describe("projectGlyph", () => {
  it("is the same figure for the same slug, forever", () => {
    expect(projectGlyph("alpamayo")).toEqual(projectGlyph("alpamayo"));
    expect(projectAccentHue("alpamayo")).toBe(projectAccentHue("alpamayo"));
  });

  it("gives different projects different figures", () => {
    expect(projectGlyph("alpamayo")).not.toEqual(projectGlyph("arc-spirits"));
  });

  it("keeps every star inside its box, so nothing is ever clipped", () => {
    for (const name of ["a", "alpamayo", "arc-spirits", "simcloud-platform", "x-9"]) {
      for (const point of projectGlyph(name).points) {
        expect(point.x - point.r).toBeGreaterThan(0);
        expect(point.x + point.r).toBeLessThan(1);
        expect(point.y - point.r).toBeGreaterThan(0);
        expect(point.y + point.r).toBeLessThan(1);
      }
    }
  });

  it("draws a path through the stars rather than a mesh between them", () => {
    const glyph = projectGlyph("alpamayo");
    expect(glyph.edges).toHaveLength(glyph.points.length - 1);
  });

  it("stays legible: four to six stars, never one and never a dozen", () => {
    for (const name of ["a", "alpamayo", "arc-spirits", "simcloud-platform", "zzz", "x-9"]) {
      const count = projectGlyph(name).points.length;
      expect(count).toBeGreaterThanOrEqual(4);
      expect(count).toBeLessThanOrEqual(6);
    }
  });

  it("keeps the accent inside a full turn of hue", () => {
    for (const name of ["a", "alpamayo", "arc-spirits", "simcloud-platform"]) {
      const hue = projectAccentHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(360);
    }
  });

  it("honours a chosen accent, and derives one from the slug when there is none", () => {
    const chosen = PROJECT_ACCENTS[3]!;
    expect(projectAccentHue("alpamayo", chosen.id)).toBe(chosen.hue);
    expect(projectAccentHue("alpamayo", "")).toBe(projectAccentHue("alpamayo"));
  });

  it("falls back to the derived accent rather than to grey for an id it does not know", () => {
    // A newer client could write an accent this build has never heard of. That
    // is not a reason to render the project as though it had no identity.
    expect(projectAccentHue("alpamayo", "ultraviolet")).toBe(projectAccentHue("alpamayo"));
  });

  it("draws a different figure per variant, and the slug's own for the default", () => {
    expect(projectGlyphSeed("alpamayo", "")).toBe("alpamayo");
    expect(projectGlyph(projectGlyphSeed("alpamayo", ""))).toEqual(projectGlyph("alpamayo"));

    const figures = PROJECT_GLYPH_VARIANTS.map((variant) =>
      JSON.stringify(projectGlyph(projectGlyphSeed("alpamayo", variant))),
    );
    expect(new Set(figures).size).toBe(PROJECT_GLYPH_VARIANTS.length);
  });

  it("keeps every variant legible and inside its box, not just the default", () => {
    for (const variant of PROJECT_GLYPH_VARIANTS) {
      const glyph = projectGlyph(projectGlyphSeed("simcloud-platform", variant));
      expect(glyph.points.length).toBeGreaterThanOrEqual(4);
      expect(glyph.points.length).toBeLessThanOrEqual(6);
      for (const point of glyph.points) {
        expect(point.x - point.r).toBeGreaterThan(0);
        expect(point.x + point.r).toBeLessThan(1);
      }
    }
  });
});
