/**
 * starcode sky — the backdrop's time-of-day phase, as CSS custom properties.
 *
 * WHAT THIS OWNS
 * Only the *phase*: it resolves the viewer's local clock to a set of colours and
 * a star opacity, writes them to `<html>`, and re-runs every minute. All the
 * painting — gradients, starfield, twinkle — lives in `starcode-theme.css`.
 * Nothing here touches the DOM beyond `documentElement.style`.
 *
 * WHY IT IS NOT A COMPONENT
 * A React component would need a mount point in the tree and would re-render on
 * every tick. This is a plain module imported once from `main.tsx`, which keeps
 * the diff to one import line and keeps the ticking entirely outside React.
 *
 * COST
 * One `setInterval` at 60s, writing ~5 custom properties. The animation is CSS
 * keyframes on opacity, so it stays on the compositor — there is no rAF loop and
 * no canvas. A chat app should not spend a GPU core on its wallpaper.
 *
 * COLOUR RANGE
 * Every phase stays in the dark half of the ramp, including "day". This is a
 * night-sky product and a bright noon backdrop would both break the brand and
 * drag the foreground tokens toward their AA floor. Day reads as a paler, quiet
 * sky with the stars faded out, not as daylight. `scripts/check-starcode-contrast.mjs`
 * verifies the text tokens against the lightest phase.
 */

/** Phase anchors, in local hours. Interpolated between, never stepped. */
interface SkyStop {
  readonly hour: number;
  /** Deepest colour, at the top of the viewport. */
  readonly top: string;
  /** The colour the gradient passes through before resolving to `--background`. */
  readonly glow: string;
  /**
   * The light theme's tint for this phase. A separate colour rather than a
   * lightened `glow`: these colours are dark and low-chroma, so mixing them into
   * linen lands on grey every time and the page looks smudged rather than lit.
   * Same hue, inverted lightness, chroma pushed back up.
   */
  readonly wash: string;
  /** Star field opacity, 0 (invisible) to 1. */
  readonly stars: number;
  readonly name: SkyPhaseName;
}

export type SkyPhaseName = "night" | "dawn" | "day" | "dusk";

/* Night and day are each anchored twice — held flat through the small hours and
   through the working day — so they are named rather than repeated. */
const NIGHT = { top: "#080a14", glow: "#0d1020", wash: "#dde1f0", stars: 1 } as const;
const DAY = { top: "#1e2739", glow: "#26304a", wash: "#d5e3f5", stars: 0 } as const;

/**
 * Fixed hour mapping rather than a sunrise API: no geolocation prompt, no
 * network dependency, no clock skew between machines. Close enough for a
 * backdrop, and wrong by at most an hour or two at the solstices.
 */
const SKY_STOPS: ReadonlyArray<SkyStop> = [
  { hour: 0, ...NIGHT, name: "night" },
  { hour: 5, ...NIGHT, name: "night" },
  { hour: 7.5, top: "#33263a", glow: "#3c2739", wash: "#f7dcd5", stars: 0.3, name: "dawn" },
  { hour: 10, ...DAY, name: "day" },
  { hour: 16.5, ...DAY, name: "day" },
  { hour: 19, top: "#2e2135", glow: "#43293c", wash: "#f9dfc3", stars: 0.35, name: "dusk" },
  { hour: 21.5, ...NIGHT, name: "night" },
  { hour: 24, ...NIGHT, name: "night" },
];

/** Hour to force for each named phase, for the dev override. */
const PHASE_HOURS: Record<SkyPhaseName, number> = {
  night: 1,
  dawn: 7.5,
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

/** Smoothstep, so a phase eases in and out instead of sliding linearly. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

export interface ResolvedSky {
  readonly top: string;
  readonly glow: string;
  readonly wash: string;
  readonly stars: number;
  readonly name: SkyPhaseName;
}

/**
 * Exported for tests: given an hour in [0, 24), return the interpolated sky.
 * The phase *name* is the nearer anchor's, so a value mid-transition reports
 * the phase it is closest to rather than inventing a fifth name.
 */
export function resolveSkyForHour(hour: number): ResolvedSky {
  const clamped = ((hour % 24) + 24) % 24;
  let lower = SKY_STOPS[0]!;
  let upper = SKY_STOPS[SKY_STOPS.length - 1]!;
  for (let index = 0; index < SKY_STOPS.length - 1; index += 1) {
    const current = SKY_STOPS[index]!;
    const next = SKY_STOPS[index + 1]!;
    if (clamped >= current.hour && clamped <= next.hour) {
      lower = current;
      upper = next;
      break;
    }
  }
  const span = upper.hour - lower.hour;
  const t = span === 0 ? 0 : ease((clamped - lower.hour) / span);
  return {
    top: mixHex(lower.top, upper.top, t),
    glow: mixHex(lower.glow, upper.glow, t),
    wash: mixHex(lower.wash, upper.wash, t),
    stars: lower.stars + (upper.stars - lower.stars) * t,
    name: t < 0.5 ? lower.name : upper.name,
  };
}

/**
 * Dev override so every phase is reachable without waiting for the clock —
 * `?sky=day` for a one-off, or `localStorage["starcode:sky"]` to pin it across
 * reloads. Accepts a phase name or a raw hour (`?sky=17.5`). A query param also
 * persists, so a pinned phase survives the navigation that follows pairing.
 *
 * Deliberately not surfaced in the UI: this exists so screenshots and desktop
 * verification are real renders rather than trusted arithmetic.
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
  root.style.setProperty("--sc-sky-top", sky.top);
  root.style.setProperty("--sc-sky-glow", sky.glow);
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
