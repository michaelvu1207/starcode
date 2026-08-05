/**
 * Fork-owned: how a project is drawn — its constellation and its accent.
 *
 * Every surface that shows a project shows this same mark: the sidebar heading,
 * the edit dialog's swatches, the seed dialog's rows, the project home. Both
 * halves default to something derived from the slug, so a project is
 * recognisable before anyone has chosen anything, and deterministic across
 * machines, so it is the *same* mark on all four.
 *
 * Separate from `ProjectCatalog.model.ts`, which decides what a project *is*
 * across those machines. This file only decides what one looks like.
 *
 * (It was `ProjectsIndex.model.ts` until F16.6 deleted the card index it was
 * named for, taking the rollup half of this file with it.)
 *
 * @module ProjectMarkModel
 */

/**
 * The constellation glyph, seeded from the slug.
 *
 * Uses F14's own FNV-1a rather than a second hash, and for the same reason that
 * file gives: any stable hash would do, what matters is that it is *this*
 * function forever, because changing it redraws every project at once.
 *
 * The result is a handful of points in a unit box plus the edges between them —
 * a constellation, not a picture. Deterministic across machines, so the same
 * project is the same shape everywhere.
 */
export interface ProjectGlyph {
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number; readonly r: number }>;
  readonly edges: ReadonlyArray<{
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  }>;
}

function fnv1a(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A stable value in [0, 1) from one slice of the hash. */
function slice(hash: number, index: number): number {
  const mixed = Math.imul(hash ^ Math.imul(index + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
  return mixed / 0x1_0000_0000;
}

/**
 * The seed a project's constellation is drawn from.
 *
 * Empty `glyph` means "whatever the slug gives", which is what every project
 * starts as and what most stay. A chosen variant is a suffix on the same seed
 * rather than a second hash, so picking one moves the figure without moving it
 * anywhere a different project already is.
 */
export function projectGlyphSeed(slug: string, glyph: string): string {
  return glyph.length === 0 ? slug : `${slug}#${glyph}`;
}

/**
 * The variants offered when an operator wants a different figure.
 *
 * Six, because the point is "not that one" rather than "exactly this one" — a
 * page of forty constellations is a decision nobody wants to make about a
 * project they just created.
 */
export const PROJECT_GLYPH_VARIANTS: ReadonlyArray<string> = ["", "2", "3", "4", "5", "6"];

export function projectGlyph(slug: string): ProjectGlyph {
  const hash = fnv1a(slug);
  // Four to six stars. Fewer reads as an accident, more stops being legible at
  // the size a card renders it.
  const count = 4 + Math.floor(slice(hash, 0) * 3);
  const points = Array.from({ length: count }, (_, index) => ({
    // Inset from the edges so a star is never clipped by the glyph's box.
    x: 0.16 + slice(hash, index * 3 + 1) * 0.68,
    y: 0.16 + slice(hash, index * 3 + 2) * 0.68,
    r: 0.045 + slice(hash, index * 3 + 3) * 0.05,
  }));

  // A path through the points in order, not a mesh: a constellation is a line
  // somebody traced, and every-pair edges would render as a blob.
  const edges = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return { x1: previous.x, y1: previous.y, x2: point.x, y2: point.y };
  });

  return { points, edges };
}

/**
 * The accents an operator can choose between.
 *
 * Every one is a rotation applied to the theme's own gold rather than a literal
 * colour, so a project cannot be given something that sits outside the palette
 * or comes out neon in one theme and muddy in the other. Named for the hue they
 * land on, not for the number of degrees, because the degrees are an
 * implementation detail of `hue-rotate` and the names are what the picker says.
 */
export interface ProjectAccentChoice {
  readonly id: string;
  readonly label: string;
  readonly hue: number;
}

export const PROJECT_ACCENTS: ReadonlyArray<ProjectAccentChoice> = [
  { id: "gold", label: "Gold", hue: 0 },
  { id: "ember", label: "Ember", hue: 315 },
  { id: "rose", label: "Rose", hue: 285 },
  { id: "iris", label: "Iris", hue: 240 },
  { id: "sky", label: "Sky", hue: 180 },
  { id: "jade", label: "Jade", hue: 105 },
];

/**
 * The hue rotation a project renders at.
 *
 * An unset accent — every project's starting state — is derived from the slug,
 * so a fresh grid is already distinguishable before anyone has chosen anything.
 * A chosen one is honoured exactly, and an accent this build does not know
 * falls back to the derived hue rather than to grey: an id written by a newer
 * client is not a reason to make a project look broken.
 */
export function projectAccentHue(slug: string, accent?: string): number {
  if (accent !== undefined && accent.length > 0) {
    const choice = PROJECT_ACCENTS.find((entry) => entry.id === accent);
    if (choice !== undefined) return choice.hue;
  }
  return Math.round(slice(fnv1a(slug), 7) * 360);
}
