/**
 * starcode sky — the backdrop's time of day, as CSS custom properties.
 *
 * WHAT THIS OWNS
 * Only the *hour*: it resolves the viewer's local clock to a set of colours and
 * a star level, writes them to `<html>`, and re-runs every minute. All the
 * painting — the field, the blur, the starfield, the drift — lives in
 * `starcode-theme.css` and `components/brand/StarcodeSky.tsx`. Nothing here
 * touches the DOM beyond `documentElement.style`.
 *
 * WHERE THE COLOURS COME FROM
 * They were measured, not chosen. `starcodeSkyTimeline.ts` is generated from a
 * real day-to-night time-lapse: sampled across its full length, reduced to one
 * small 2D colour field per moment, then compressed into this palette by
 * `scripts/lib/starcode-sky-timeline.mjs`. What survives from the footage is the
 * arc and the shape. What does not survive is the photograph. See that script's
 * header for every decision in between; it is the interesting file, not this one.
 *
 * This module used to carry eight hand-picked colours across four phases. It now
 * carries none: the table is 38 keyframes, each holding a tiny PNG, and the only
 * thing left here is finding which two the clock sits between.
 *
 * WHY IT HANDS OVER A PAIR RATHER THAN A COLOUR
 * The fields are images, and images do not interpolate in CSS. So instead of
 * blending them here — which would mean a canvas, a re-encode every minute, and
 * a main-thread cost on a wallpaper — this resolves the two keyframes either
 * side of now and how far between them the clock is, and the stylesheet stacks
 * them and sets the top one's opacity. The crossfade is a compositor property on
 * two static, already-rasterised layers.
 *
 * WHY IT IS NOT A COMPONENT
 * A React component would need a mount point in the tree and would re-render on
 * every tick. This is a plain module imported once from `main.tsx`, which keeps
 * the diff to one import line and keeps the ticking entirely outside React.
 *
 * COST
 * One `setInterval` at 60s, writing six custom properties. Two of them are the
 * same data URIs as last minute for twenty-nine minutes out of thirty, so the
 * browser reuses the decoded image and the blurred raster behind it. Everything
 * that moves is a CSS animation on the compositor — there is no rAF loop and no
 * canvas. A chat app should not spend a GPU core on its wallpaper.
 *
 * TUNING
 * Not here. Every knob is a named constant in
 * `scripts/lib/starcode-sky-timeline.mjs`; change one and run
 * `node scripts/derive-starcode-sky-timeline.mjs`. Then run
 * `node scripts/check-starcode-contrast.mjs`, which sweeps the whole timeline
 * against every text token in both themes and exits non-zero.
 *
 * Force an hour without waiting for the clock: `?sky=night|dawn|day|dusk`, a raw
 * hour (`?sky=17.5`, `?sky=6.25` — anything in [0, 24) now resolves, since the
 * table is continuous rather than four phases). `?sky=auto` hands it back to the
 * real time. The choice persists, and `<html data-sky-phase>` reports what
 * actually rendered.
 */
import { SKY_TIMELINE, type SkyPhaseName } from "./starcodeSkyTimeline";

export type { SkyPhaseName };

/** Hour to force for each named phase, for the dev override. Sunrise is 6.83
    and sunset 19, so these are the most photogenic minute of each. */
const PHASE_HOURS: Record<SkyPhaseName, number> = {
  night: 1,
  dawn: 6.9,
  day: 13,
  dusk: 19,
};

const STORAGE_KEY = "starcode:sky";
const QUERY_KEY = "sky";

function parseHex(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(channels: readonly [number, number, number]): string {
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

export interface ResolvedSky {
  /** The keyframe before now, and the one after. Both are PNG data URIs. */
  readonly fieldA: string;
  readonly fieldB: string;
  /** How far between them the clock is, 0 to 1 — frame B's opacity. */
  readonly blend: number;
  /** The colour at the top of the window: titlebar tint and first-paint fill. */
  readonly top: string;
  /** The light theme's tint. */
  readonly wash: string;
  /** Star field opacity, 0 to 1. */
  readonly stars: number;
  readonly name: SkyPhaseName;
}

/**
 * Exported for tests: given an hour in [0, 24), return the sky.
 *
 * The two fields come back unblended — see the header. The scalars beside them
 * are interpolated linearly, not eased: the four-phase table this replaced
 * needed smoothstep because its anchors were hours apart and a linear ramp
 * between them read as a slide; this table is half an hour apart through every
 * twilight and was already Gaussian-smoothed at derivation time, so easing each
 * segment would add a flat spot at every keyframe rather than remove one.
 *
 * The phase *name* is the nearer keyframe's, so a value mid-transition reports
 * the phase it is closest to rather than inventing a fifth name.
 */
export function resolveSkyForHour(hour: number): ResolvedSky {
  const clamped = ((hour % 24) + 24) % 24;
  let lower = SKY_TIMELINE[0]!;
  let upper = SKY_TIMELINE[SKY_TIMELINE.length - 1]!;
  for (let index = 0; index < SKY_TIMELINE.length - 1; index += 1) {
    const current = SKY_TIMELINE[index]!;
    const next = SKY_TIMELINE[index + 1]!;
    if (clamped >= current.hour && clamped <= next.hour) {
      lower = current;
      upper = next;
      break;
    }
  }
  const span = upper.hour - lower.hour;
  const t = span === 0 ? 0 : (clamped - lower.hour) / span;

  return {
    fieldA: lower.field,
    fieldB: upper.field,
    blend: t,
    top: mixHex(lower.top, upper.top, t),
    wash: mixHex(lower.wash, upper.wash, t),
    stars: lower.stars + (upper.stars - lower.stars) * t,
    name: t < 0.5 ? lower.name : upper.name,
  };
}

/**
 * Dev override so every hour is reachable without waiting for the clock —
 * `?sky=day` for a one-off, or `localStorage["starcode:sky"]` to pin it across
 * reloads. Accepts a phase name or a raw hour (`?sky=17.5`). A query param also
 * persists, so a pinned hour survives the navigation that follows pairing.
 *
 * Deliberately not surfaced in the UI: this exists so screenshots and desktop
 * verification are real renders rather than trusted arithmetic. With a 38-point
 * table the raw-hour form is now the useful one — every half hour of a twilight
 * is a different sky.
 */
function readOverrideHour(): number | null {
  if (typeof window === "undefined") return null;

  let raw: string | null = null;
  try {
    raw = new URLSearchParams(window.location.search).get(QUERY_KEY);
    if (raw !== null) {
      window.localStorage.setItem(STORAGE_KEY, raw);
    } else {
      raw = window.localStorage.getItem(STORAGE_KEY);
    }
  } catch {
    // Private-mode storage or an exotic URL: fall back to the real clock.
    return null;
  }

  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "auto" || trimmed === "off") return null;
  if (trimmed in PHASE_HOURS) return PHASE_HOURS[trimmed as SkyPhaseName];
  const asHour = Number.parseFloat(trimmed);
  return Number.isFinite(asHour) ? asHour : null;
}

function currentHour(): number {
  const override = readOverrideHour();
  if (override !== null) return override;
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

export function applySky(root: HTMLElement, sky: ResolvedSky): void {
  root.style.setProperty("--sc-sky-field-a", `url("${sky.fieldA}")`);
  root.style.setProperty("--sc-sky-field-b", `url("${sky.fieldB}")`);
  root.style.setProperty("--sc-sky-blend", sky.blend.toFixed(4));
  root.style.setProperty("--sc-sky-top", sky.top);
  root.style.setProperty("--sc-sky-wash", sky.wash);
  root.style.setProperty("--sc-sky-stars", sky.stars.toFixed(3));
  // Readable from the DOM so screenshots and the desktop check can assert which
  // phase actually rendered.
  root.dataset.skyPhase = sky.name;
}

/**
 * Starts the clock. Idempotent per document — calling twice replaces the timer
 * rather than stacking a second one.
 */
export function startStarcodeSky(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const root = document.documentElement;

  const tick = (): void => {
    applySky(root, resolveSkyForHour(currentHour()));
  };

  tick();
  const existing = window.__starcodeSkyTimer;
  if (existing !== undefined) window.clearInterval(existing);
  // Minutes, not frames: the sky moves slowly enough that a 60s tick is
  // indistinguishable from continuous, and the transition between values is
  // done by CSS rather than by stepping.
  window.__starcodeSkyTimer = window.setInterval(tick, 60_000);
  // A laptop that slept through dawn should not keep painting night.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
}

declare global {
  interface Window {
    __starcodeSkyTimer?: number;
  }
}
