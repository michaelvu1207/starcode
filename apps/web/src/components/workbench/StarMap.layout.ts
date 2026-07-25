/**
 * Fork-owned: the shape of the sky.
 *
 * The sky is one constellation growing from one point. At the bottom, on the
 * horizon, sits **the origin** — the latest shared state everybody starts from.
 * Every feature branches off it: directly, or off another feature when it is
 * waiting on that work. Altitude is how far a feature has got, so a branch that
 * matures climbs, and the whole picture reads as growth from a common root
 * rather than as rows of unrelated dots.
 *
 * Two encodings and no others:
 *
 *   - **altitude is stage** — in flight, landed, ready, shipped, from the
 *     horizon toward the zenith;
 *   - **lineage is the branch** — what a feature grew out of.
 *
 * There is deliberately nothing here about machines. Which server runs a piece
 * of work is not a property of the work, and the version of this file that made
 * it geography answered a question nobody asks.
 *
 * **Positions are stable across reloads.** Horizontal placement is a tidy-tree
 * allocation over a deterministic ordering, nudged by a hash of each feature's
 * own key. Nothing consults `Math.random`, render order, or recency, so two
 * visits to the same sky are pixel-identical. What a position does depend on is
 * the shape of the tree around it: a new sibling divides the span its parent
 * owns, which is the one rearrangement that cannot be avoided without letting
 * branches overlap.
 */
import type { FeatureFlowStage } from "@t3tools/contracts";

import { FEATURE_FLOW_STAGES, FEATURE_FLOW_STAGE_LABELS } from "./FeatureFlow.model";
import type { SkyFeature, SkyModel } from "./StarMap.model";

export interface SkyLayoutOptions {
  /** Left axis holding the tier names. */
  readonly gutterWidth: number;
  readonly paddingRight: number;
  /** Least clear sky kept above the top tier, where the moon hangs. */
  readonly zenithHeight: number;
  /**
   * Ceiling on how tall one tier grows. Without it a tall pane spreads four
   * tiers over eight hundred pixels and every branch becomes a wire; the stack
   * is anchored to the origin instead and the surplus becomes open sky.
   */
  readonly maxTierHeight: number;
  /** The strip below the origin carrying its name. */
  readonly horizonHeight: number;
  /** Gap between the origin and the first tier, so the root reads as a root. */
  readonly originGap: number;
  readonly originRadius: number;
  readonly starRadius: number;
  /** Smallest horizontal span a feature is allotted before siblings crowd. */
  readonly minSlotWidth: number;
  readonly moonRadius: number;
}

export const SKY_LAYOUT: SkyLayoutOptions = {
  // Wide enough for the longest tier name at the axis type size.
  gutterWidth: 88,
  paddingRight: 18,
  zenithHeight: 52,
  maxTierHeight: 150,
  horizonHeight: 34,
  originGap: 34,
  originRadius: 9,
  starRadius: 7,
  minSlotWidth: 44,
  moonRadius: 13,
};

/** Below this the sky is too cramped to read; the pane scrolls instead. */
export const SKY_MIN_HEIGHT = 340;
export const SKY_MIN_WIDTH = 320;

/**
 * What each tier is called on screen.
 *
 * Not the contract's own names, and not git's. "in-dev" is an implementation
 * detail of where containment was tested; what an operator wants to read is
 * whether the work has landed in what everyone else is building on. One
 * constant, so the vocabulary is one edit away from being different.
 */
export const SKY_TIER_LABELS: Readonly<Record<FeatureFlowStage, string>> = {
  "in-progress": "in flight",
  "in-dev": "landed",
  "in-staging": "ready",
  "in-production": "shipped",
};

/** The root everything grows from. */
export const SKY_ORIGIN_LABEL = "latest";

export interface SkyTierLayout {
  readonly stage: FeatureFlowStage;
  readonly label: string;
  readonly top: number;
  readonly height: number;
  readonly centerY: number;
}

export interface SkyPlacedFeature {
  readonly feature: SkyFeature;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Depth in the lineage tree; 0 branches straight off the origin. */
  readonly depth: number;
  readonly twinklePeriodSeconds: number;
  readonly twinkleDelaySeconds: number;
}

export interface SkyBranchLayout {
  readonly key: string;
  /** Null when the branch grows straight out of the origin. */
  readonly fromKey: string | null;
  readonly toKey: string;
  readonly d: string;
  /** True when either end is intent rather than work. */
  readonly planned: boolean;
  /** Draw-in order, so the constellation traces outward from the root. */
  readonly order: number;
}

export interface SkyOriginLayout {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly label: string;
}

export interface SkyLayout {
  readonly width: number;
  readonly height: number;
  readonly tiers: ReadonlyArray<SkyTierLayout>;
  readonly features: ReadonlyArray<SkyPlacedFeature>;
  readonly branches: ReadonlyArray<SkyBranchLayout>;
  readonly origin: SkyOriginLayout;
  readonly moon: { readonly x: number; readonly y: number; readonly radius: number } | null;
  /** Top of the tier stack. Everything above it is open sky. */
  readonly skyTop: number;
  readonly horizonY: number;
  readonly options: SkyLayoutOptions;
}

/**
 * FNV-1a over the feature key.
 *
 * Any stable hash would do; what matters is that it is *this* function forever,
 * because changing it moves every star in the sky at once.
 */
export function skySeed(key: string): number {
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
 * or above twenty seconds: a star you can watch blink competes with the work.
 */
const TWINKLE_PERIODS_SECONDS = [19, 23, 29] as const;

const round = (value: number): number => Math.round(value * 100) / 100;

export interface SkyForest {
  /** Features branching straight off the origin, in draw order. */
  readonly roots: ReadonlyArray<string>;
  readonly childrenOf: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly depthOf: ReadonlyMap<string, number>;
}

/**
 * Resolves every feature to exactly one parent.
 *
 * A feature may record several things it waits on; the tree can only draw one
 * lineage, so the first surviving link wins and the rest are simply not drawn.
 * Showing them all would turn the constellation into a mesh, which is the thing
 * a lineage picture exists to avoid — and the extra links are still visible on
 * the card.
 *
 * Cycles cannot be laid out at all, so any feature whose ancestry loops is
 * re-rooted at the origin. The server refuses to write a cycle, which makes
 * this the defence against a map written by an older build rather than an
 * expected state.
 */
export function buildSkyForest(features: ReadonlyArray<SkyFeature>): SkyForest {
  const byKey = new Map(features.map((feature) => [feature.key, feature]));
  const parentOf = new Map<string, string>();

  for (const feature of features) {
    const parent = feature.dependsOnKeys.find((key) => byKey.has(key));
    if (parent !== undefined) parentOf.set(feature.key, parent);
  }

  // Re-root anything whose ancestry loops or runs deeper than the sky can show.
  const depthOf = new Map<string, number>();
  for (const feature of features) {
    const seen = new Set<string>([feature.key]);
    let depth = 0;
    let cursor = parentOf.get(feature.key);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentOf.delete(feature.key);
        depth = 0;
        break;
      }
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor);
    }
    depthOf.set(feature.key, depth);
  }

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  // Deterministic order: the tree must be the same picture on every render.
  for (const feature of [...features].toSorted((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    const parent = parentOf.get(feature.key);
    if (parent === undefined) roots.push(feature.key);
    else childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), feature.key]);
  }

  return { roots, childrenOf, parentOf, depthOf };
}

/** Leaves under a key, which is the width its subtree needs. */
function leafCount(key: string, forest: SkyForest, cache: Map<string, number>): number {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const children = forest.childrenOf.get(key) ?? [];
  const total =
    children.length === 0
      ? 1
      : children.reduce((sum, child) => sum + leafCount(child, forest, cache), 0);
  cache.set(key, total);
  return total;
}

/**
 * A branch, drawn as a curve that leaves its parent going up and arrives at its
 * child going up.
 *
 * Control points offset along the vertical span rather than a fixed distance,
 * so a short hop between adjacent tiers stays gentle and a long one still
 * leaves the parent cleanly instead of shooting sideways.
 */
function branchPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const span = (toY - fromY) * 0.55;
  return `M ${round(fromX)} ${round(fromY)} C ${round(fromX)} ${round(fromY + span)} ${round(toX)} ${round(toY - span)} ${round(toX)} ${round(toY)}`;
}

/**
 * Pushes apart stars that ended up on top of each other in the same tier.
 *
 * The tidy allocation centres a node over the span its subtree owns, which is
 * exactly right until a feature's only child sits in the *same* tier as its
 * parent: both centre on the same span and land on the same point, and one of
 * them becomes unhoverable. A single-parent chain that has not yet climbed is a
 * completely ordinary state — the plan describes it constantly — so this is a
 * correctness pass, not a cosmetic one.
 *
 * One sweep right, one sweep back, both clamped to the field. Ordering is by x
 * with the key as the tie-break, so the result stays deterministic.
 */
function separateWithinTiers(
  placed: ReadonlyArray<SkyPlacedFeature>,
  byKey: Map<string, SkyPlacedFeature>,
  fieldLeft: number,
  fieldRight: number,
  options: SkyLayoutOptions,
): void {
  const minGap = options.starRadius * 2 + 12;
  const rows = new Map<number, SkyPlacedFeature[]>();
  for (const entry of placed) {
    const key = FEATURE_FLOW_STAGES.indexOf(entry.feature.stage);
    rows.set(key, [...(rows.get(key) ?? []), entry]);
  }

  for (const row of rows.values()) {
    if (row.length < 2) continue;
    const sorted = [...row].toSorted(
      (left, right) => left.x - right.x || left.feature.key.localeCompare(right.feature.key),
    );
    let cursor = fieldLeft;
    for (const entry of sorted) {
      const x = Math.max(entry.x, cursor);
      byKey.set(entry.feature.key, { ...entry, x: round(x) });
      cursor = x + minGap;
    }
    // The forward sweep can run a crowded tier off the right edge; the reverse
    // sweep pulls it back without re-introducing an overlap.
    let limit = fieldRight;
    for (const entry of sorted.toReversed()) {
      const current = byKey.get(entry.feature.key)!;
      const x = Math.min(current.x, limit);
      byKey.set(entry.feature.key, { ...current, x: round(x) });
      limit = x - minGap;
    }
  }
}

export function layoutSky(
  model: SkyModel,
  size: { readonly width: number; readonly height: number },
  options: SkyLayoutOptions = SKY_LAYOUT,
): SkyLayout {
  const width = Math.max(SKY_MIN_WIDTH, Math.floor(size.width));
  const height = Math.max(SKY_MIN_HEIGHT, Math.floor(size.height));

  const horizonY = height - options.horizonHeight;
  const originY = horizonY - options.originRadius;
  const tiersBottom = originY - options.originGap;
  const available = Math.max(80, tiersBottom - options.zenithHeight);
  const tierHeight = Math.min(available / FEATURE_FLOW_STAGES.length, options.maxTierHeight);
  const skyTop = tiersBottom - tierHeight * FEATURE_FLOW_STAGES.length;

  const tiers = FEATURE_FLOW_STAGES.map((stage, index): SkyTierLayout => {
    // Index 0 is the first tier and belongs nearest the origin, so the sky is
    // read upward the way the work grows.
    const rowFromTop = FEATURE_FLOW_STAGES.length - 1 - index;
    const top = skyTop + rowFromTop * tierHeight;
    return {
      stage,
      label: SKY_TIER_LABELS[stage] ?? FEATURE_FLOW_STAGE_LABELS[stage],
      top: round(top),
      height: round(tierHeight),
      centerY: round(top + tierHeight / 2),
    };
  });
  const tierByStage = new Map(tiers.map((tier) => [tier.stage, tier]));

  const fieldLeft = options.gutterWidth;
  const fieldWidth = Math.max(120, width - options.gutterWidth - options.paddingRight);
  const originX = fieldLeft + fieldWidth / 2;

  const forest = buildSkyForest(model.features);
  const byKey = new Map(model.features.map((feature) => [feature.key, feature]));
  const cache = new Map<string, number>();

  const placed: SkyPlacedFeature[] = [];
  const placedByKey = new Map<string, SkyPlacedFeature>();

  /**
   * Allocates a horizontal span to a subtree and centres the node in it, then
   * divides the remainder among its children in proportion to their own width.
   */
  const place = (key: string, left: number, span: number) => {
    const feature = byKey.get(key);
    if (feature === undefined) return;
    const tier = tierByStage.get(feature.stage) ?? tiers[tiers.length - 1]!;
    const seed = skySeed(key);
    // Jitter is bounded by the slot so a nudge can never push a star into a
    // sibling's column, and by a constant so a wide slot does not scatter it.
    const nudgeX = jitter(seed, 0) * Math.min(span * 0.16, 16);
    const nudgeY = jitter(seed, 1) * Math.min(tier.height * 0.2, 20);
    const period = TWINKLE_PERIODS_SECONDS[seed % TWINKLE_PERIODS_SECONDS.length]!;
    const entry: SkyPlacedFeature = {
      feature,
      x: round(left + span / 2 + nudgeX),
      y: round(tier.centerY + nudgeY),
      radius: options.starRadius,
      depth: forest.depthOf.get(key) ?? 0,
      twinklePeriodSeconds: period,
      twinkleDelaySeconds: -round((((seed >>> 11) & 0xff) / 0xff) * period),
    };
    placed.push(entry);
    placedByKey.set(key, entry);

    const children = forest.childrenOf.get(key) ?? [];
    if (children.length === 0) return;
    const total = children.reduce((sum, child) => sum + leafCount(child, forest, cache), 0);
    let cursor = left;
    for (const child of children) {
      const childSpan = (leafCount(child, forest, cache) / total) * span;
      place(child, cursor, childSpan);
      cursor += childSpan;
    }
  };

  const rootTotal = forest.roots.reduce((sum, key) => sum + leafCount(key, forest, cache), 0);
  let cursor = fieldLeft;
  for (const key of forest.roots) {
    const span =
      rootTotal === 0 ? fieldWidth : (leafCount(key, forest, cache) / rootTotal) * fieldWidth;
    place(key, cursor, span);
    cursor += span;
  }

  separateWithinTiers(placed, placedByKey, fieldLeft, fieldLeft + fieldWidth, options);
  // The pass writes replacements into the lookup, so the ordered list has to be
  // re-read from it before the branches are routed against those positions.
  const separated = placed.map((entry) => placedByKey.get(entry.feature.key) ?? entry);

  // Branches, outward from the root: the order the sky traces itself in.
  const branches: SkyBranchLayout[] = [];
  const walk = (key: string, order: { value: number }) => {
    const child = placedByKey.get(key);
    if (child === undefined) return;
    const parentKey = forest.parentOf.get(key);
    const parent = parentKey === undefined ? null : placedByKey.get(parentKey);
    const fromX = parent?.x ?? originX;
    const fromY = parent?.y ?? originY;
    branches.push({
      key: `${parentKey ?? "origin"}->${key}`,
      fromKey: parentKey ?? null,
      toKey: key,
      d: branchPath(fromX, fromY, child.x, child.y),
      planned: child.feature.planned || (parent?.feature.planned ?? false),
      order: order.value,
    });
    order.value += 1;
    for (const next of forest.childrenOf.get(key) ?? []) walk(next, order);
  };
  const order = { value: 0 };
  for (const key of forest.roots) walk(key, order);

  const moon =
    model.master === null
      ? null
      : {
          x: round(width - options.paddingRight - options.moonRadius - 14),
          y: round(Math.max(options.moonRadius + 12, skyTop / 2)),
          radius: options.moonRadius,
        };

  return {
    width,
    height,
    tiers,
    features: separated,
    branches,
    origin: {
      x: round(originX),
      y: round(originY),
      radius: options.originRadius,
      label: SKY_ORIGIN_LABEL,
    },
    moon,
    skyTop: round(skyTop),
    horizonY: round(horizonY),
    options,
  };
}
