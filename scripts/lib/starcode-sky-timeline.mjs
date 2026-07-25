/**
 * The sky timeline: a day-to-night time-lapse, restyled into the brand's palette
 * and stretched over a 24-hour clock.
 *
 * WHAT THIS IS FOR
 * `starcodeSky.ts` used to interpolate eight hand-picked colours. Those colours
 * were invented; these are measured. The source is a real time-lapse — afternoon
 * through sunset, blue hour, and into full night — reduced to a vertical
 * gradient signature per frame (`starcode-sky-source.json`, see the header there
 * for the extraction method). This module turns that signature into the keyframe
 * table the app ships.
 *
 * WHY THE VIDEO IS NOT USED VERBATIM, WHICH IS THE WHOLE DESIGN
 * A photograph of a sky is a terrible application background. It is bright, it
 * is noisy, its chroma belongs to a camera sensor rather than to a palette, and
 * its daylight would drag every foreground token to its AA floor. What is worth
 * keeping is the *arc*: the order the colours arrive in, how long each lasts,
 * where the warmth sits in the frame, and how fast twilight moves. That is the
 * colour script. Everything else is re-authored.
 *
 * So the transform below is deliberately lossy, in five named steps:
 *
 *   1. LIGHTNESS is compressed into the dark half of the ramp. The video's noon
 *      sits near OKLab L 0.66; the brightest sky this app will ever paint is
 *      `LIGHTNESS_CEILING`. Every stop is then clamped against ITS OWN
 *      keyframe's star level, which is what lets noon be daylight while
 *      pre-dawn stays dark — see `holdContrast`, and the section header above it
 *      for the screenshot that proved a single global ceiling wrong.
 *   2. CHROMA is compressed toward the palette, but non-linearly, so a sunset
 *      keeps its relative punch against a grey afternoon instead of everything
 *      landing on the same muted average. It is also *floored*, because the
 *      source's overcast daylight is nearly achromatic and a literal transfer
 *      would paint the working day concrete-grey.
 *   3. HUE is pulled toward the two brand attractors — butter for anything warm,
 *      starlight for anything cool. This is what makes a photograph of someone
 *      else's sky look like it belongs to this app.
 *   4. NIGHT IS ANCHORED, and this one is law rather than taste: the deep-night
 *      keyframes resolve to the kit's `#0e1117`. The palette is anchored on that
 *      black and a sky that drifts off it re-opens a seam the fork already
 *      closed once.
 *   5. THE ARC IS SMOOTHED. The source is a compilation with two hard cuts and a
 *      fade-to-black outro; a Gaussian over the hour axis turns the cuts into the
 *      time skips they actually represent, and the per-frame medians upstream
 *      already dropped the sun disc and the city lights. Nothing that happens in
 *      one frame of the source can become a keyframe.
 *
 * THE MORNING IS THE EVENING, MIRRORED — AND SAID OUT LOUD
 * The source only films day-to-night, so there is no dawn in it. Dawn is the
 * dusk arc reflected about local noon, because the sun's path is symmetric and
 * pretending otherwise would mean inventing colours with no source at all. It is
 * not a pixel copy: a real dawn is cooler and cleaner than a dusk (the day's
 * haze has not been raised yet), so the mirrored half is rotated toward rose and
 * pulled down in chroma, and the glow anchor rises in the east instead of
 * setting in the west. Those two asymmetries are what stop the sky reading as a
 * palindrome.
 *
 * GEOMETRY COMES FROM PHYSICS, NOT FROM THE FOOTAGE
 * The extractor also tracks the brightest column near the horizon, and that
 * track is discarded. Across the source's two cuts the camera azimuth changes,
 * and after dark the "sun" it locks onto is a city. A sweep from east to west on
 * a fixed schedule is both more plausible and more useful — it is the only thing
 * that makes dawn and dusk distinguishable at a glance.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const sourcePath = NodePath.resolve(here, "starcode-sky-source.json");

/* ---------------------------------------------------------------------------
 * Colour space. OKLab throughout, because every operation below is a
 * perceptual one — "a bit less saturated", "rotate toward butter", "half as
 * light" — and sRGB gets all three visibly wrong on dark blues, which is most
 * of this timeline.
 * ------------------------------------------------------------------------ */

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((c) => srgbToLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, a, bb]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.min(255, Math.max(0, Math.round(linearToSrgb(Math.max(0, c)) * 255))));
}

const toLch = ([L, a, b]) => [L, Math.hypot(a, b), Math.atan2(b, a)];
const fromLch = ([L, C, h]) => [L, C * Math.cos(h), C * Math.sin(h)];
export const hexToRgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
export const rgbToHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
const hexToLch = (hex) => toLch(rgbToOklab(hexToRgb(hex)));

/** Shortest-arc interpolation between two hue angles. */
function mixHue(from, to, t) {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta * t;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------------------------------------------------------------------------
 * The knobs. Everything taste-bearing is here, named, in one block.
 * ------------------------------------------------------------------------ */

/** The palette's ground. The night resolves to exactly this; see step 4. */
const INK_GROUND = "#0e1117";
/** Warm attractor: `--sc-butter`. Cool attractor: `--sc-starlight`. */
const WARM_ANCHOR = "#f0d9a0";
const COOL_ANCHOR = "#93b1de";

/** How far a hue is dragged toward its nearer attractor. 0 keeps the camera's
    colour, 1 discards the video and paints the brand twice. */
const HUE_PULL = 0.38;

/** Chroma: `out = GAIN * in^GAMMA`, then held between the floor and the ceiling.
    Gamma below 1 lifts the low end, so an overcast afternoon still carries a
    tint while a sunset stays clearly the most saturated thing in the day. */
const CHROMA_GAIN = 0.42;
const CHROMA_GAMMA = 0.72;
/** The ceiling rides lightness: saturated darks read as muddy rather than rich,
    and the app spends most of its hours down there. */
const CHROMA_CEILING_AT_DARK = 0.036;
const CHROMA_CEILING_AT_TWILIGHT = 0.082;
const CHROMA_CEILING_AT_DAY = 0.058;
/** The floor is what keeps the working day from landing on concrete. The source
    is overcast for its whole daylight stretch, and overcast is achromatic; a
    faithful transfer paints the hours Michael actually works in the colour of a
    car park. The floor is the single most consequential number in this file. */
const CHROMA_FLOOR_AT_DAY = 0.038;

/** Below this the source colour has no hue worth keeping — it is camera noise
    on a grey sky — so it takes the cool anchor outright instead of being pulled
    only part of the way toward it. Set above the observed chroma of the
    overcast daylight (~0.012) and well below a sunset's (~0.05). */
const HUE_MEANINGFUL_CHROMA = 0.022;

/** The bend in the lightness map, above 1 so the curve is convex.
 *
 * This started at 0.85 (concave, lifting the low end) on the theory that the
 * twilights were the part worth protecting. With a single global ceiling that
 * was true. With the per-keyframe contrast clamp it is exactly backwards: the
 * clamp already holds every starlit hour to the floor, so lifting the low end
 * just pushes more stops INTO the clamp, where they all flatten onto the same
 * lightness and the night stops telling one hour from another. Bending the
 * other way keeps the dark hours dark on their own merits and spends the range
 * on the daylight, which is the half nothing else is holding down. Measured, not
 * guessed: 0.85 clamps 79 of 190 stops, 1.0 clamps 47, this clamps 22, and 1.45
 * starts costing dusk its blue. */
const LIGHTNESS_GAMMA = 1.2;

/** The deepest the sky ever goes, as an OKLab L. Below the ink ground, so the
    zenith at 3am is fractionally deeper than the app surface under it — the sky
    reads as *behind* the UI rather than level with it. The source agrees: its
    night zenith is genuinely darker than `#0e1117`. */
const LIGHTNESS_FLOOR_OFFSET = -0.014;

/** The cool cast the zenith keeps once the light has gone.
 *
 * The night resolves to `#0e1117` — that is the law, and the gradient's foot is
 * transparent so every surface below it composites onto exactly that black. What
 * this number buys is the ceiling: pinning the *zenith* to the ground as well
 * makes the whole viewport one flat fill for the seven hours either side of
 * midnight, which is a lot of the working night to spend on a blank wall. A
 * chroma this small is invisible as colour and unmistakable as depth. */
const NIGHT_GROUND_CHROMA = 0.019;

/** Smoothing over the hour axis, in minutes. Must be at least half the finest
    keyframe spacing (30 min) or the table aliases the arc it is sampling. */
const SMOOTHING_MINUTES = 20;

/** Where the sun crosses. Fixed, not geolocated: no permission prompt, no
    network, no clock skew between the four machines this runs on. */
export const SUNSET_HOUR = 19;
export const SUNRISE_HOUR = 6.83;

/** How much of the source maps to a clock hour before the fade-to-black outro
    (which begins around t=0.96 and would otherwise become midnight). */
const USABLE_T_END = 0.95;

/**
 * Source time to clock hour. Piecewise linear through anchors read off the
 * footage; the two entries that share a t are the compilation's hard cuts,
 * which are time skips rather than colour jumps — mapping the two sides to
 * different clock times is what makes the smoothing pass turn them into
 * twenty-minute transitions instead of a visible seam.
 */
const CLOCK_ANCHORS = [
  { t: 0.0, hour: 16.0 }, // hazy afternoon, sun still well up
  { t: 0.094, hour: 17.75 }, // sun low and blazing through cloud
  { t: 0.22, hour: SUNSET_HOUR }, // disc on the horizon
  { t: 0.344, hour: 19.6 }, // last frame before the first cut
  { t: 0.36, hour: 20.0 }, // first frame after it
  { t: 0.5, hour: 20.75 }, // blue hour, city lights on
  { t: 0.6, hour: 21.3 },
  { t: 0.73, hour: 21.9 }, // last frame before the second cut
  { t: 0.75, hour: 22.2 },
  { t: USABLE_T_END, hour: 24.0 },
];

/** The hour the day plateau starts, i.e. the clock time of source t=0. */
const DAY_PLATEAU_END = CLOCK_ANCHORS[0].hour;
/** Mirror: an evening hour `e` and a morning hour `m` show the same sun. */
const mirrorHour = (hour) => SUNRISE_HOUR + SUNSET_HOUR - hour;
const DAY_PLATEAU_START = mirrorHour(DAY_PLATEAU_END);
const NIGHT_PLATEAU_END = mirrorHour(24);

/** Dawn's departure from a mirrored dusk. Peaks at sunrise and vanishes into
    both plateaus, so the two halves still meet without a step. */
const DAWN_HUE_ROTATION = (-16 * Math.PI) / 180;
const DAWN_CHROMA_SCALE = 0.86;
const DAWN_LIGHTNESS_SCALE = 1.03;

/** How far either side of centre the low glow travels, as a percentage of the
    viewport. It rides a cosine on a 24-hour period phased to sunrise, so it is
    east at dawn, west at dusk, and — the part that matters — continuous across
    midnight. A piecewise sweep that resets at 00:00 slides the glow across the
    whole screen at the exact moment the date changes. */
const GLOW_X_CENTRE = 50;
const GLOW_X_SWING = 38;

/** Stars, as thresholds on the SOURCE's own zenith brightness normalised to
    [0, 1] over the clip — not on the output colour.
    Reading them off the output would be circular: the per-keyframe contrast
    clamp below needs the star level to decide how light a sky may be, so the
    star level cannot in turn be a function of how light the sky came out. The
    source is the fixed input both derive from, which breaks the loop and also
    makes "how starry is this hour" mean the honest thing — how dark the sky
    actually was when it was filmed. */
const STARS_GONE_ABOVE_SOURCE = 0.32;
const STARS_FULL_BELOW_SOURCE = 0.12;

/** The light theme's wash keeps the hour's hue but inverts its lightness — a
    lightened sky colour lands on grey every time, which reads as a smudge. */
const WASH_LIGHTNESS = 0.918;
const WASH_CHROMA_GAIN = 1.9;
const WASH_CHROMA_CEILING = 0.041;

/** The low glow's alpha band. The floor is not zero: the source's night has a
    real warm ember on the horizon (a city under the sky), and keeping a trace of
    it is what stops 3am reading as a switched-off screen. */
const EMBER_ALPHA_FLOOR = 0.05;
const EMBER_ALPHA_RANGE = 0.29;
/** How tightly the glow is confined to the hours around sunrise and sunset.
    Without this the source's overcast afternoon — which has a warm break at the
    horizon — smears an ochre band across the bottom of the screen at noon. */
const EMBER_ALTITUDE_WIDTH = 0.34;

/** The keyframe grid: one hour through the two plateaus, half an hour through
    the twilights, where the whole arc happens. */
const GRID_SEGMENTS = [
  [0, 4, 1],
  [4, 10, 0.5],
  [10, 17, 1],
  [17, 22, 0.5],
  [22, 24.0001, 0.5],
];

/* ------------------------------------------------------------------------ */

let cachedSource = null;
function readSource() {
  cachedSource ??= JSON.parse(NodeFS.readFileSync(sourcePath, "utf8"));
  return cachedSource;
}

/** Source colour at a given `t`, linearly interpolated in OKLab. */
function sampleSource(t) {
  const { samples } = readSource();
  const clamped = Math.min(USABLE_T_END, Math.max(0, t));
  let lower = samples[0];
  let upper = samples[samples.length - 1];
  for (let i = 0; i < samples.length - 1; i += 1) {
    if (clamped >= samples[i].t && clamped <= samples[i + 1].t) {
      lower = samples[i];
      upper = samples[i + 1];
      break;
    }
  }
  const span = upper.t - lower.t;
  const k = span === 0 ? 0 : (clamped - lower.t) / span;
  return lower.stops.map((stop, index) => {
    const a = rgbToOklab(stop);
    const b = rgbToOklab(upper.stops[index]);
    return a.map((v, c) => lerp(v, b[c], k));
  });
}

/** Clock hour to source `t`. The inverse of CLOCK_ANCHORS, plus the plateaus. */
export function hourToSourceT(hour) {
  const h = ((hour % 24) + 24) % 24;
  // Morning half: reflect it onto the evening and let the same anchors serve.
  const evening = h < DAY_PLATEAU_START ? mirrorHour(h) : h;
  if (evening <= DAY_PLATEAU_END) return 0;
  if (evening >= 24) return USABLE_T_END;
  for (let i = 0; i < CLOCK_ANCHORS.length - 1; i += 1) {
    const lower = CLOCK_ANCHORS[i];
    const upper = CLOCK_ANCHORS[i + 1];
    if (evening >= lower.hour && evening <= upper.hour) {
      const span = upper.hour - lower.hour;
      const k = span === 0 ? 0 : (evening - lower.hour) / span;
      return lerp(lower.t, upper.t, k);
    }
  }
  return USABLE_T_END;
}

/** True for the hours served by the mirror rather than by the footage. */
const isMorning = (hour) => hour < DAY_PLATEAU_START && hour > NIGHT_PLATEAU_END;

/** Dawn asymmetry weight: a bump peaking at sunrise, zero at both plateaus. */
function dawnWeight(hour) {
  if (!isMorning(hour)) return 0;
  const span =
    hour < SUNRISE_HOUR ? SUNRISE_HOUR - NIGHT_PLATEAU_END : DAY_PLATEAU_START - SUNRISE_HOUR;
  return smoothstep(1 - Math.abs(hour - SUNRISE_HOUR) / span);
}

/* ---------------------------------------------------------------------------
 * The taste transform.
 * ------------------------------------------------------------------------ */

const warmHue = hexToLch(WARM_ANCHOR)[2];
const coolHue = hexToLch(COOL_ANCHOR)[2];
const groundLch = hexToLch(INK_GROUND);

/** The source's own lightness range, measured once, so the compression below is
    relative to what was actually filmed rather than to a guessed 0..1. */
function sourceLightnessRange() {
  const { samples } = readSource();
  let min = Infinity;
  let max = -Infinity;
  for (const sample of samples) {
    if (sample.t > USABLE_T_END) continue;
    for (const stop of sample.stops) {
      const L = rgbToOklab(stop)[0];
      min = Math.min(min, L);
      max = Math.max(max, L);
    }
  }
  return { min, max };
}

/**
 * One source colour to one shipped colour.
 *
 * `ceiling` is the brightest OKLab lightness the sky may reach — passed in
 * rather than baked so `solveLightnessCeiling` can bisect on it.
 */
function restyle([L, a, b], ceiling, range) {
  const [, C, h] = toLch([L, a, b]);
  const floor = groundLch[0] + LIGHTNESS_FLOOR_OFFSET;

  // 1. Lightness, compressed into the dark half of the ramp — see
  //    LIGHTNESS_GAMMA for why the curve bends the way it does.
  const normalized = clamp01((L - range.min) / (range.max - range.min));
  const outL = lerp(floor, ceiling, normalized ** LIGHTNESS_GAMMA);

  // How far up the ramp this colour sits, used to shape the chroma envelope.
  const lift = clamp01((outL - floor) / (ceiling - floor));

  // 2. Chroma, compressed and then bounded by an envelope that peaks at
  //    twilight — the only hours with a real sunset in them.
  const ceilingC =
    lift < 0.45
      ? lerp(CHROMA_CEILING_AT_DARK, CHROMA_CEILING_AT_TWILIGHT, smoothstep(lift / 0.45))
      : lerp(CHROMA_CEILING_AT_TWILIGHT, CHROMA_CEILING_AT_DAY, smoothstep((lift - 0.45) / 0.55));
  const floorC = CHROMA_FLOOR_AT_DAY * lift * lift;
  const outC = Math.min(ceilingC, Math.max(floorC, CHROMA_GAIN * C ** CHROMA_GAMMA));

  // 3. Hue, dragged toward whichever brand anchor it is already nearer. Done on
  //    the source hue, before the chroma floor invents one: a near-neutral grey
  //    has no meaningful hue of its own, so it inherits the cool anchor, which
  //    is the correct reading of an overcast sky.
  const meaningful = C > HUE_MEANINGFUL_CHROMA;
  const target =
    Math.abs(mixHue(h, warmHue, 1) - h) < Math.abs(mixHue(h, coolHue, 1) - h) ? warmHue : coolHue;
  const outH = meaningful ? mixHue(h, target, HUE_PULL) : coolHue;

  return fromLch([outL, outC, outH]);
}

/**
 * Step 4, and the one rule in this file that is not negotiable.
 *
 * As the sky runs out of light it converges on `#0e1117` rather than on the
 * camera's near-black, which sat a long way off the palette in both hue and
 * lightness. The weight is driven by the *output* lightness, so it engages on
 * the strength of the resulting sky rather than on a clock time — and the
 * darkest hours land on the ground exactly, not approximately.
 */
function anchorToGround(lab, ceiling) {
  const floor = groundLch[0] + LIGHTNESS_FLOOR_OFFSET;
  const lift = clamp01((toLch(lab)[0] - floor) / (ceiling - floor));
  const weight = 1 - smoothstep(lift / 0.22);
  if (weight <= 0) return lab;
  const ground = fromLch([groundLch[0] + LIGHTNESS_FLOOR_OFFSET, NIGHT_GROUND_CHROMA, coolHue]);
  return lab.map((v, i) => lerp(v, ground[i], weight));
}

/** A dense, evenly spaced pass over the clock, before smoothing and sampling. */
const FINE_STEP_HOURS = 1 / 12; // five minutes

function buildFineTrack(ceiling) {
  const range = sourceLightnessRange();
  const track = [];
  for (let hour = 0; hour < 24; hour += FINE_STEP_HOURS) {
    const stops = sampleSource(hourToSourceT(hour));
    const dawn = dawnWeight(hour);
    const styled = stops.map((lab, index) => {
      let out = restyle(lab, ceiling, range);
      if (dawn > 0) {
        // The mirrored half, made its own hour: cooler, cleaner, a touch
        // brighter aloft. Scaled by the bump so both plateaus still meet.
        const [L, C, h] = toLch(out);
        const upper = 1 - index / (stops.length - 1);
        out = fromLch([
          L * lerp(1, DAWN_LIGHTNESS_SCALE, dawn * upper),
          C * lerp(1, DAWN_CHROMA_SCALE, dawn),
          h + DAWN_HUE_ROTATION * dawn,
        ]);
      }
      return anchorToGround(out, ceiling);
    });
    track.push({ hour, stops: styled });
  }
  return track;
}

/** Gaussian over the hour axis, wrapping at midnight so the join is seamless. */
function smoothTrack(track) {
  const sigma = SMOOTHING_MINUTES / 60 / FINE_STEP_HOURS; // in samples
  const radius = Math.ceil(sigma * 3);
  const weights = [];
  for (let d = -radius; d <= radius; d += 1) weights.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);

  return track.map((_, i) =>
    track[i].stops.map((_, s) => {
      const acc = [0, 0, 0];
      weights.forEach((w, k) => {
        const j = (i + k - radius + track.length * 2) % track.length;
        for (let c = 0; c < 3; c += 1) acc[c] += track[j].stops[s][c] * w;
      });
      return acc.map((v) => v / total);
    }),
  );
}

/* ---------------------------------------------------------------------------
 * The derived quantities: stars, the light theme's wash, and the glow anchor.
 * ------------------------------------------------------------------------ */

/** Source zenith brightness at an hour, normalised over the whole clip. */
function sourceZenith(hour) {
  const range = sourceLightnessRange();
  const L = sampleSource(hourToSourceT(hour))[0][0];
  return clamp01((L - range.min) / (range.max - range.min));
}

function starsFor(hour) {
  const n = sourceZenith(hour);
  return Number(
    smoothstep(
      (STARS_GONE_ABOVE_SOURCE - n) / (STARS_GONE_ABOVE_SOURCE - STARS_FULL_BELOW_SOURCE),
    ).toFixed(3),
  );
}

function washFor(stops) {
  // Whichever band carries the hour's colour most strongly; at night that is
  // the low ember, at midday the zenith. Taking the most chromatic stop rather
  // than a fixed one is why the light theme warms at dusk and cools at noon
  // without a second table.
  let best = stops[0];
  let bestC = -1;
  for (const stop of stops) {
    const C = toLch(stop)[1];
    if (C > bestC) {
      bestC = C;
      best = stop;
    }
  }
  const [, C, h] = toLch(best);
  return rgbToHex(
    oklabToRgb(fromLch([WASH_LIGHTNESS, Math.min(WASH_CHROMA_CEILING, C * WASH_CHROMA_GAIN), h])),
  );
}

/**
 * The low glow — the sky's one directional light, and the thing that stops the
 * backdrop reading as a symmetric vertical ramp.
 *
 * Colour comes from the source band just above the horizon, which is where a
 * sunset actually lives. Strength is how far that band departs from the sky
 * above it: large at sunrise and sunset, near zero at noon (an even sky) and
 * near zero at 3am (an even dark). No threshold and no schedule — the number
 * falls out of the footage.
 */
function emberFor(hour, ceiling, range) {
  const stops = sampleSource(hourToSourceT(hour));
  const horizon = stops[stops.length - 1];
  const above = stops[stops.length - 3];
  const [hL, hC] = toLch(horizon);
  const [aL, aC] = toLch(above);
  const departure = clamp01((hL - aL) / 0.12) * 0.6 + clamp01((hC - aC) / 0.05) * 0.4;

  let lab = restyle(horizon, ceiling, range);
  const dawn = dawnWeight(hour);
  if (dawn > 0) {
    const [L, C, h] = toLch(lab);
    lab = fromLch([L, C * DAWN_CHROMA_SCALE, h + DAWN_HUE_ROTATION * dawn]);
  }
  // Painted as a soft additive-looking wash at a low alpha, so the colour itself
  // is lifted well above the gradient it sits on; at the shipped alpha the
  // composite lands back in the palette.
  const [L, C, h] = toLch(lab);
  const lifted = fromLch([Math.min(0.72, L + 0.3), Math.min(0.11, C * 2.4), h]);

  // A horizon glow is a horizon phenomenon: it belongs to the hours when the sun
  // is near the horizon and to no others. `altitude` is a proxy — +1 at solar
  // noon, -1 at solar midnight — and the glow is a narrow bump around zero.
  const altitude = -Math.cos((2 * Math.PI * (hour - (SUNRISE_HOUR + SUNSET_HOUR) / 2)) / 24);
  const nearHorizon = Math.exp(-((altitude / EMBER_ALTITUDE_WIDTH) ** 2));

  return {
    color: rgbToHex(oklabToRgb(lifted)),
    alpha: Number(
      (EMBER_ALPHA_FLOOR + EMBER_ALPHA_RANGE * smoothstep(departure) * nearHorizon).toFixed(3),
    ),
    // East at dawn, west at dusk. The footage's own azimuth is deliberately not
    // used — see the header.
    x: Number(
      (GLOW_X_CENTRE - GLOW_X_SWING * Math.cos((2 * Math.PI * (hour - SUNRISE_HOUR)) / 24)).toFixed(
        1,
      ),
    ),
  };
}

/* ------------------------------------------------------------------------ */

function gridHours() {
  const hours = [];
  for (const [from, to, step] of GRID_SEGMENTS) {
    for (let h = from; h < to; h += step) hours.push(Number(h.toFixed(2)));
  }
  if (hours[hours.length - 1] !== 24) hours.push(24);
  return hours;
}

/**
 * Build the shipped table at a given lightness ceiling.
 *
 * Returns keyframes of `{ hour, stops: [top, high, glow, low, horizon], wash,
 * stars, ember }`. The last keyframe is hour 24 and is identical to hour 0 by
 * construction, so the day wraps without a step at midnight.
 */
export function buildTimeline(ceiling = LIGHTNESS_CEILING) {
  const range = sourceLightnessRange();
  const smoothed = smoothTrack(buildFineTrack(ceiling));
  const at = (hour) => {
    const index = Math.round((((hour % 24) + 24) % 24) / FINE_STEP_HOURS) % smoothed.length;
    return smoothed[index];
  };

  clampedStops = 0;
  totalStops = 0;

  return gridHours().map((hour) => {
    const stops = at(hour);
    const stars = starsFor(hour);
    // Five gradient stops from the source's six bands: the sixth is the horizon
    // itself, which drives the ember rather than the gradient. A warm band
    // pinned to the bottom edge of the viewport would sit behind the composer.
    const gradient = stops.slice(0, 5).map((lab) => holdContrast(lab, stars));
    return {
      hour,
      stops: gradient.map((lab) => rgbToHex(oklabToRgb(lab))),
      wash: washFor(stops),
      stars,
      ember: emberFor(hour, ceiling, range),
    };
  });
}

/* ---------------------------------------------------------------------------
 * The contrast clamp, and why it is PER KEYFRAME.
 *
 * `--sc-star-chrome-max` set the precedent: a number that can make text harder
 * to read is solved against the gate rather than chosen by eye. The brightest
 * the sky may get is exactly such a number.
 *
 * The first version of this solved ONE ceiling for the whole day, and the
 * screenshots showed why that is wrong. A single ceiling has to satisfy the
 * worst hour, and the worst hour is around 21:00 — a sky still holding some
 * light with a full starfield already on it. Every other hour then inherits
 * that limit, so noon came out the same lightness as dusk and the app looked
 * identical at 12:00 and 19:00. On a feature whose entire premise is "the
 * background should change through the day", that is not a tuning miss; it is
 * the feature not working.
 *
 * The constraint is not a property of the day. It is a property of the *stop*:
 * text has to clear the floor on the surface it actually lands on, which is the
 * gradient plus whatever the chrome starfield puts on top of it. At noon the
 * starfield is at zero, so the surface is the gradient alone and it can go a
 * long way lighter for the same guarantee. So every stop is clamped against its
 * own keyframe's star level, and midday gets the daylight it is entitled to.
 *
 * `LIGHTNESS_CEILING` is therefore no longer solved — it is a taste knob that
 * sets how bright the brightest hour reads, and the clamp below is the law that
 * no setting of it can break. `--check` fails if the knob is turned up far
 * enough that the clamp is doing the composing instead of merely bounding it.
 * ------------------------------------------------------------------------ */

const hexChannels = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
const relLin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const relLum = (h) => {
  const [r, g, b] = hexChannels(h).map(relLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrastRatio = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
export function compositeOver(fg, alpha, bg) {
  const [f, b] = [fg, bg].map(hexChannels);
  return rgbToHex(f.map((v, i) => Math.round((v * alpha + b[i] * (1 - alpha)) * 255)));
}

/** The tightest dark text token, and the star ceiling it has to survive. */
export const TIGHTEST_DARK_TEXT = "#c7b8a1"; // --muted-foreground
export const STAR_TINT = "#eadcc6";
export const STAR_CHROME_MAX = 0.26;
export const BRIGHTEST_STAR_IN_TILE = 0.86;
/** Margin over AA. The gate itself holds 4.5; the solver leaves headroom so a
    later palette nudge does not immediately break the sky. */
export const SOLVE_FLOOR = 4.7;

/** Worst contrast any dark text token sees across a whole timeline. */
export function worstSkyContrast(timeline) {
  let worst = Infinity;
  let where = null;
  for (const frame of timeline) {
    for (const [index, stop] of frame.stops.entries()) {
      const lit =
        frame.stars > 0
          ? compositeOver(STAR_TINT, frame.stars * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, stop)
          : stop;
      for (const surface of [stop, lit]) {
        const r = contrastRatio(TIGHTEST_DARK_TEXT, surface);
        if (r < worst) {
          worst = r;
          where = { hour: frame.hour, stop: index, surface };
        }
      }
    }
  }
  return { ratio: worst, where };
}

/** Counters for `--check`, reset at the top of every `buildTimeline`. */
let clampedStops = 0;
let totalStops = 0;
export const clampReport = () => ({ clamped: clampedStops, total: totalStops });

/**
 * Hold one stop to the contrast floor, given its keyframe's star level.
 *
 * Only lightness moves — hue and chroma are what the taste transform decided and
 * are none of this function's business. Bisected on the real composited colour
 * rather than on a luminance approximation, because at these chromas the
 * approximation is wrong by enough to matter at the floor.
 */
function holdContrast(lab, stars) {
  const [L, C, h] = toLch(lab);
  const holds = (candidate) => {
    const hex = rgbToHex(oklabToRgb(fromLch([candidate, C, h])));
    const lit =
      stars > 0
        ? compositeOver(STAR_TINT, stars * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, hex)
        : hex;
    return contrastRatio(TIGHTEST_DARK_TEXT, lit) >= SOLVE_FLOOR;
  };

  totalStops += 1;
  if (holds(L)) return lab;

  clampedStops += 1;
  let low = 0;
  let high = L;
  for (let i = 0; i < 18; i += 1) {
    const mid = (low + high) / 2;
    if (holds(mid)) low = mid;
    else high = mid;
  }
  return fromLch([low, C, h]);
}

/**
 * How bright the brightest hour reads. TASTE, not a solved value — the clamp
 * above is what keeps it legal. Raising it makes noon more like daylight and
 * leaves the night untouched (the night is nowhere near this); lowering it
 * flattens the day back toward the night, which is the failure the per-keyframe
 * clamp exists to undo. 0.50 in OKLab is a mid slate-blue: unmistakably a
 * different time of day from 03:00, and still in the dark half of the ramp,
 * which is the brand rule this file does not get to overrule.
 */
export const LIGHTNESS_CEILING = 0.5;

/**
 * Phase names, for `<html data-sky-phase>` and the handful of CSS rules that key
 * off it. Derived from the solved sunrise and sunset rather than listed, so
 * moving either anchor cannot leave the names pointing at the wrong hours.
 */
export function phaseForHour(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= SUNRISE_HOUR - 1.5 && h <= SUNRISE_HOUR + 1.5) return "dawn";
  if (h > SUNRISE_HOUR + 1.5 && h < SUNSET_HOUR - 1.5) return "day";
  if (h >= SUNSET_HOUR - 1.5 && h <= SUNSET_HOUR + 1.5) return "dusk";
  return "night";
}

export const SOURCE_META = () => readSource();
