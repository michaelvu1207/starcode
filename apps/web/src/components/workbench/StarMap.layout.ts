/**
 * Fork-owned: where every star sits.
 *
 * The map encodes two things in two axes, and nothing else:
 *
 *   - **altitude is stage.** Work rises. In progress sits at the horizon, then
 *     dev, staging, and production toward the zenith. A viewer reads how far a
 *     piece of work has got by how high it is, before reading a single word.
 *   - **azimuth is machine.** Each paired machine owns a vertical region of the
 *     sky, named on the horizon beneath it, its stars joined by figure lines
 *     into one constellation.
 *
 * Positions are computed here rather than left to flex for the same reason the
 * lanes that preceded this file computed theirs: the constellation lines are
 * drawn over the same coordinate space the stars occupy, and a line that guesses
 * where a star ended up is a line that misses it on somebody else's font
 * metrics.
 *
 * **Positions are stable across reloads.** Every offset comes from a hash of the
 * star's own key, never from `Math.random`, never from render order, and never
 * from how recently the work moved. Two visits to a sky holding the same work
 * are pixel-identical; a sky whose stars wander between visits is a sky you
 * cannot learn. What a position *does* depend on is which other stars share its
 * cell — adding work to a crowded stage nudges its neighbours apart, which is
 * the one rearrangement that cannot be designed away without letting stars
 * overlap.
 */
import type { FeatureFlowStage } from "@t3tools/contracts";

import { FEATURE_FLOW_STAGES, FEATURE_FLOW_STAGE_LABELS } from "./FeatureFlow.model";
import type { StarMapModel, StarMapStar } from "./StarMap.model";

export interface StarMapLayoutOptions {
  /** Left axis holding the stage names. */
  readonly gutterWidth: number;
  readonly paddingRight: number;
  /** Least clear sky kept above the top band, where the moon hangs. */
  readonly zenithHeight: number;
  /**
   * Ceiling on how tall one stage band grows.
   *
   * Without it a tall pane spreads four bands over eight hundred pixels, which
   * scatters every constellation into isolated dots joined by lines long enough
   * to read as wiring. The stack is anchored to the horizon instead and the
   * surplus becomes open sky above it — which is also where the moon wants to
   * be, and what a star chart looks like.
   */
  readonly maxBandHeight: number;
  /** The strip below the lowest band carrying the machine names. */
  readonly horizonHeight: number;
  /** Kept clear inside each region so stars never touch a region divider. */
  readonly regionInset: number;
  readonly starRadius: number;
  /** Smallest horizontal gap between two stars before they wrap to a new row. */
  readonly starSpacingX: number;
  /** Vertical distance between wrapped rows inside one band. */
  readonly rowGap: number;
  readonly moonRadius: number;
}

export const STAR_MAP_LAYOUT: StarMapLayoutOptions = {
  // Wide enough for "PRODUCTION" at the axis type size without the label
  // running off the left edge of the pane.
  gutterWidth: 96,
  paddingRight: 18,
  zenithHeight: 52,
  maxBandHeight: 170,
  horizonHeight: 30,
  regionInset: 16,
  starRadius: 7,
  starSpacingX: 34,
  rowGap: 26,
  moonRadius: 13,
};

/** Below this the sky is too cramped to read; the pane scrolls instead. */
export const STAR_MAP_MIN_HEIGHT = 320;
export const STAR_MAP_MIN_WIDTH = 320;

export interface StarMapBandLayout {
  readonly stage: FeatureFlowStage;
  readonly label: string;
  readonly top: number;
  readonly height: number;
  readonly centerY: number;
}

export interface StarMapRegionLayout {
  readonly environmentId: string;
  readonly label: string;
  readonly isLocal: boolean;
  readonly x: number;
  readonly width: number;
  readonly centerX: number;
  /** Divider drawn on this region's left edge; null for the leftmost. */
  readonly dividerX: number | null;
}

export interface StarMapPlacedStar {
  readonly star: StarMapStar;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Seconds, so the value can go straight into a CSS custom property. */
  readonly twinklePeriodSeconds: number;
  /** Negative seconds: the star is already mid-cycle when it first paints. */
  readonly twinkleDelaySeconds: number;
}

export type StarMapEdgeKind = "figure" | "dependency";

export interface StarMapEdgeLayout {
  readonly key: string;
  readonly kind: StarMapEdgeKind;
  readonly fromKey: string;
  readonly toKey: string;
  readonly d: string;
  /** Draw-in order, so the constellations trace out rather than blink on. */
  readonly order: number;
}

export interface StarMapMoonLayout {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface StarMapLayout {
  readonly width: number;
  readonly height: number;
  readonly bands: ReadonlyArray<StarMapBandLayout>;
  readonly regions: ReadonlyArray<StarMapRegionLayout>;
  readonly stars: ReadonlyArray<StarMapPlacedStar>;
  readonly edges: ReadonlyArray<StarMapEdgeLayout>;
  readonly moon: StarMapMoonLayout | null;
  /** Top of the band stack. Everything above it is open sky. */
  readonly skyTop: number;
  /** The rule the machine names sit under. */
  readonly horizonY: number;
  readonly options: StarMapLayoutOptions;
}

/**
 * FNV-1a over the star key.
 *
 * Any stable hash would do; what matters is that it is *this* function forever,
 * because changing it moves every star in the sky at once.
 */
export function starSeed(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A seeded value in [-1, 1), from one slice of the hash. */
function jitter(seed: number, slice: number): number {
  const shifted = (seed >>> (slice * 7)) & 0x3ff;
  return (shifted / 0x3ff) * 2 - 1;
}

/**
 * Twinkle periods with no common multiple inside a working session, so the
 * field never falls into step with itself and starts reading as a beat. All at
 * or above twenty seconds: a star you can watch blink is a star that is
 * competing with the work.
 */
const TWINKLE_PERIODS_SECONDS = [19, 23, 29] as const;

/**
 * Chains a region's stars into one constellation figure.
 *
 * Nearest neighbour from the lowest star upward: the eye follows a wandering
 * line better than a star it has to find on its own, and starting at the
 * horizon means the figure is traced in the direction the work flows. The line
 * carries one claim — these stars are the same machine — which is exactly the
 * grouping the region already asserts, so it can never say anything the rest of
 * the map does not.
 */
function figureChain(
  placed: ReadonlyArray<StarMapPlacedStar>,
): ReadonlyArray<readonly [StarMapPlacedStar, StarMapPlacedStar]> {
  if (placed.length < 2) return [];
  const remaining = [...placed].sort(
    (left, right) => right.y - left.y || left.star.key.localeCompare(right.star.key),
  );
  const pairs: Array<readonly [StarMapPlacedStar, StarMapPlacedStar]> = [];
  let current = remaining.shift()!;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((candidate, index) => {
      const dx = candidate.x - current.x;
      const dy = candidate.y - current.y;
      const distance = dx * dx + dy * dy;
      // Ties resolve on key so the figure is the same on every machine that
      // renders it.
      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          candidate.star.key.localeCompare(remaining[bestIndex]!.star.key) < 0)
      ) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const next = remaining.splice(bestIndex, 1)[0]!;
    pairs.push([current, next]);
    current = next;
  }
  return pairs;
}

/**
 * A dependency connector, bowed sideways.
 *
 * Straight would be ambiguous the moment two dependencies span the same pair of
 * altitudes; the bow grows with the distance covered, which is what keeps a
 * short hop from looking like a long one.
 */
function dependencyPath(from: StarMapPlacedStar, to: StarMapPlacedStar, seed: number): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.hypot(dx, dy);
  if (span < 1) return `M ${round(from.x)} ${round(from.y)} L ${round(to.x)} ${round(to.y)}`;
  const depth = Math.min(26, 5 + span / 7) * (jitter(seed, 3) < 0 ? -1 : 1);
  // Perpendicular offset from the midpoint: a quadratic whose control point
  // sits off the chord by `depth`.
  const controlX = midX + (-dy / span) * depth;
  const controlY = midY + (dx / span) * depth;
  return `M ${round(from.x)} ${round(from.y)} Q ${round(controlX)} ${round(controlY)} ${round(to.x)} ${round(to.y)}`;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function layoutStarMap(
  model: StarMapModel,
  size: { readonly width: number; readonly height: number },
  options: StarMapLayoutOptions = STAR_MAP_LAYOUT,
): StarMapLayout {
  const width = Math.max(STAR_MAP_MIN_WIDTH, Math.floor(size.width));
  const height = Math.max(STAR_MAP_MIN_HEIGHT, Math.floor(size.height));

  const horizonY = height - options.horizonHeight;
  const available = Math.max(80, horizonY - options.zenithHeight);
  const bandHeight = Math.min(available / FEATURE_FLOW_STAGES.length, options.maxBandHeight);
  // Anchored to the horizon: work always starts from the same line, whatever
  // the pane's height, and the leftover becomes sky rather than lane padding.
  const skyTop = horizonY - bandHeight * FEATURE_FLOW_STAGES.length;

  const bands = FEATURE_FLOW_STAGES.map((stage, index): StarMapBandLayout => {
    // Index 0 is in-progress and belongs at the bottom, so the sky is read
    // upward the way the work flows.
    const rowFromTop = FEATURE_FLOW_STAGES.length - 1 - index;
    const top = skyTop + rowFromTop * bandHeight;
    return {
      stage,
      label: FEATURE_FLOW_STAGE_LABELS[stage],
      top: round(top),
      height: round(bandHeight),
      centerY: round(top + bandHeight / 2),
    };
  });
  const bandByStage = new Map(bands.map((band) => [band.stage, band]));

  const fieldLeft = options.gutterWidth;
  const fieldWidth = Math.max(120, width - options.gutterWidth - options.paddingRight);
  const regionCount = Math.max(1, model.regions.length);
  const regionWidth = fieldWidth / regionCount;

  const regions = model.regions.map((region, index): StarMapRegionLayout => {
    const x = fieldLeft + index * regionWidth;
    return {
      environmentId: region.environmentId,
      label: region.label,
      isLocal: region.isLocal,
      x: round(x),
      width: round(regionWidth),
      centerX: round(x + regionWidth / 2),
      dividerX: index === 0 ? null : round(x),
    };
  });

  const stars: StarMapPlacedStar[] = [];
  const placedByKey = new Map<string, StarMapPlacedStar>();
  const placedByRegion = new Map<string, StarMapPlacedStar[]>();

  model.regions.forEach((region, regionIndex) => {
    const regionLayout = regions[regionIndex]!;
    const cellLeft = regionLayout.x + options.regionInset;
    const cellWidth = Math.max(40, regionLayout.width - options.regionInset * 2);
    const regionPlaced: StarMapPlacedStar[] = [];

    for (const stage of FEATURE_FLOW_STAGES) {
      const band = bandByStage.get(stage)!;
      const cell = region.stars.filter((star) => star.stage === stage);
      if (cell.length === 0) continue;

      // Wrap into rows before stars start colliding, rather than letting a busy
      // stage squeeze its stars into a line of touching dots.
      const perRow = Math.max(1, Math.floor(cellWidth / options.starSpacingX));
      const rowCount = Math.ceil(cell.length / perRow);
      const stackHeight = (rowCount - 1) * options.rowGap;
      const firstRowY = band.centerY - stackHeight / 2;
      // Room left for jitter after the rows have taken their share.
      const slack = Math.max(0, band.height / 2 - stackHeight / 2 - options.starRadius * 3);

      cell.forEach((star, index) => {
        const row = Math.floor(index / perRow);
        const rowStart = row * perRow;
        const rowSize = Math.min(perRow, cell.length - rowStart);
        const column = index - rowStart;
        const seed = starSeed(star.key);
        const slotWidth = cellWidth / rowSize;
        const x = cellLeft + slotWidth * (column + 0.5) + jitter(seed, 0) * slotWidth * 0.24;
        // Stars use most of the slack the band leaves them. A tighter bound
        // lines them up on the band's centre, and a row of evenly spaced dots
        // at one altitude reads as a chart axis rather than as a sky.
        const y = firstRowY + row * options.rowGap + jitter(seed, 1) * Math.min(slack, 26);
        const placed: StarMapPlacedStar = {
          star,
          x: round(x),
          y: round(y),
          radius: options.starRadius,
          twinklePeriodSeconds: TWINKLE_PERIODS_SECONDS[seed % TWINKLE_PERIODS_SECONDS.length]!,
          twinkleDelaySeconds: -round(
            (((seed >>> 11) & 0xff) / 0xff) *
              TWINKLE_PERIODS_SECONDS[seed % TWINKLE_PERIODS_SECONDS.length]!,
          ),
        };
        stars.push(placed);
        regionPlaced.push(placed);
        placedByKey.set(star.key, placed);
      });
    }
    placedByRegion.set(region.environmentId, regionPlaced);
  });

  const edges: StarMapEdgeLayout[] = [];
  for (const region of model.regions) {
    for (const [from, to] of figureChain(placedByRegion.get(region.environmentId) ?? [])) {
      edges.push({
        key: `figure:${from.star.key}->${to.star.key}`,
        kind: "figure",
        fromKey: from.star.key,
        toKey: to.star.key,
        d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`,
        order: 0,
      });
    }
  }
  for (const placed of stars) {
    for (const dependsOnKey of placed.star.dependsOnKeys) {
      const target = placedByKey.get(dependsOnKey);
      if (target === undefined) continue;
      edges.push({
        key: `depends:${placed.star.key}->${dependsOnKey}`,
        kind: "dependency",
        fromKey: placed.star.key,
        toKey: dependsOnKey,
        d: dependencyPath(placed, target, starSeed(placed.star.key)),
        order: 0,
      });
    }
  }
  // Figure lines trace out first and dependencies land over them, so the sky
  // reads as constellations that then reveal what waits on what.
  const ordered = edges
    .toSorted(
      (left, right) =>
        (left.kind === "figure" ? 0 : 1) - (right.kind === "figure" ? 0 : 1) ||
        left.key.localeCompare(right.key),
    )
    .map((edge, index) => ({ ...edge, order: index }));

  const moon =
    model.master === null
      ? null
      : {
          x: round(width - options.paddingRight - options.moonRadius - 14),
          // Centred in whatever open sky sits above the top band, so a tall
          // pane hangs the moon high rather than pinning it to the pane's edge.
          y: round(Math.max(options.moonRadius + 12, skyTop / 2)),
          radius: options.moonRadius,
        };

  return {
    width,
    height,
    bands,
    regions,
    stars,
    edges: ordered,
    moon,
    skyTop: round(skyTop),
    horizonY: round(horizonY),
    options,
  };
}
