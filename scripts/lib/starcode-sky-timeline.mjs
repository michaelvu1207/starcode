/**
 * The sky timeline: a day-to-night time-lapse, restyled into the brand's palette
 * and stretched over a 24-hour clock.
 *
 * WHAT THIS IS FOR
 * `starcodeSky.ts` used to interpolate eight hand-picked colours. Those colours
 * were invented; these are measured. The source is a real time-lapse — afternoon
 * through sunset, blue hour, and into full night — reduced to one small 2D
 * colour field per sampled moment (`starcode-sky-source.json`, see the header
 * there for the extraction method). This module turns those fields into the
 * keyframe table the app ships: one tiny PNG per keyframe, which the app
 * upscales to the viewport and blurs.
 *
 * WHY A FIELD AND NOT A GRADIENT — the correction that produced this version.
 * Version one shipped six vertical colour stops per keyframe and rendered them
 * as a `linear-gradient`. The verdict was "it just looks like a simple gradient,
 * there should be some dimensionality — as if we just blurred the video". Both
 * halves of that are the same defect: a vertical stop list has no horizontal
 * information *by construction*, so no amount of tuning could have produced a
 * cloud mass, an off-centre glow, or a patch of colour that is not the average
 * of its latitude. The fix is not a better gradient. It is to stop throwing the
 * second dimension away, and to let an upscale and a blur do what a gradient was
 * standing in for.
 *
 * WHY THE VIDEO IS STILL NOT USED VERBATIM
 * A photograph of a sky is a terrible application background. It is bright, it
 * is noisy, its chroma belongs to a camera sensor rather than to a palette, and
 * its daylight would drag every foreground token to its AA floor. What is worth
 * keeping is the *arc* and now also the *shape*: the order the colours arrive
 * in, how long each lasts, where the warmth sits in the frame, and how fast
 * twilight moves. That is the colour script. Everything else is re-authored,
 * per cell, in five named steps:
 *
 *   1. LIGHTNESS is compressed into the dark half of the ramp. The video's noon
 *      sits near OKLab L 0.66; the brightest cell this app will paint is
 *      `LIGHTNESS_CEILING`. Every cell is then clamped against ITS OWN
 *      keyframe's star level — see `holdContrast`.
 *   2. CHROMA is compressed toward the palette, but non-linearly, so a sunset
 *      keeps its relative punch against a grey afternoon instead of everything
 *      landing on the same muted average. It is also *floored*, because the
 *      source's overcast daylight is nearly achromatic and a literal transfer
 *      would paint the working day concrete-grey.
 *   3. HUE is pulled toward the two brand attractors — butter for anything warm,
 *      starlight for anything cool. Pulled, not replaced: the pull is what makes
 *      someone else's sky belong to this app, and the part left unpulled is what
 *      keeps one cell a different colour from its neighbour.
 *   4. NIGHT IS ANCHORED, and this one is law rather than taste: the deep-night
 *      keyframes resolve to the kit's `#0e1117`. The palette is anchored on that
 *      black and a sky that drifts off it re-opens a seam the fork already
 *      closed once.
 *   5. THE ARC IS SMOOTHED. The source is a compilation with two hard cuts and a
 *      fade-to-black outro; a Gaussian over the hour axis turns the cuts into the
 *      time skips they actually represent, and the temporal median upstream
 *      already dropped anything that lived for one frame.
 *
 * THE MORNING IS THE EVENING, MIRRORED — TWICE, AND SAID OUT LOUD
 * The source only films day-to-night, so there is no dawn in it. Dawn is the
 * dusk arc reflected about local noon, because the sun's path is symmetric and
 * pretending otherwise would mean inventing colours with no source at all. It is
 * not a copy: the mirrored half is rotated toward rose and pulled down in
 * chroma, because a real dawn is cooler and cleaner than a dusk (the day's haze
 * has not been raised yet) — and the field is also mirrored LEFT TO RIGHT, so
 * the glow that set in the west rises in the east. That second mirror is free,
 * exact, and does the job the old synthesised sun-azimuth sweep was doing by
 * hand. It is the reason dawn and dusk are told apart at a glance.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

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
    colour, 1 discards the video and paints the brand twice.
    Relaxed from 0.38 when the field replaced the gradient: with 240 cells
    instead of 6 stops, the hue differences BETWEEN cells are the shape, and
    pulling them all toward two anchors is pulling them toward each other. */
const HUE_PULL = 0.28;

/** Chroma: `out = GAIN * in^GAMMA`, then held between the floor and the ceiling.
    Gamma below 1 lifts the low end, so an overcast afternoon still carries a
    tint while a sunset stays clearly the most saturated thing in the day.
    Raised across the board for the field render — a gradient shows its colour
    over a whole panel and a cell shows it over a twentieth of one, so the same
    number reads much weaker. */
const CHROMA_GAIN = 0.62;
const CHROMA_GAMMA = 0.66;
/** The ceiling rides lightness: saturated darks read as muddy rather than rich,
    and the app spends most of its hours down there. */
const CHROMA_CEILING_AT_DARK = 0.05;
const CHROMA_CEILING_AT_TWILIGHT = 0.132;
const CHROMA_CEILING_AT_DAY = 0.086;
/** The floor is what keeps the working day from landing on concrete. The source
    is overcast for its whole daylight stretch, and overcast is achromatic; a
    faithful transfer paints the hours Michael actually works in the colour of a
    car park. */
const CHROMA_FLOOR_AT_DAY = 0.038;

/** Below this the source colour has no hue worth keeping — it is camera noise
    on a grey sky — so it takes the cool anchor outright instead of being pulled
    only part of the way toward it. */
const HUE_MEANINGFUL_CHROMA = 0.022;

/**
 * How bright the brightest cell reads. TASTE, not a solved value — `holdContrast`
 * is what keeps it legal.
 *
 * The binding legibility constraint is text sitting on the RAW sky, and the only
 * place that happens is the pairing screen, where the token is `--foreground`
 * (a cream, which clears 4.5:1 down to roughly OKLab L 0.56). Everything inside
 * the app shell reads the sky through a structural panel, which is darker than
 * the sky and can only raise contrast. So this sits far higher than the 0.373
 * the first version solved for — that number came from holding the tightest
 * *body* token against a bare sky it never actually lands on.
 */
const LIGHTNESS_CEILING = 0.56;

/** The bend in the lightness map, above 1 so the curve is convex. Keeps the dark
    hours dark on their own merits and spends the range on the daylight, which is
    the half nothing else is holding down. Below 1 pushes more cells into the
    contrast clamp, where they flatten onto one lightness and stop telling one
    hour from another. */
const LIGHTNESS_GAMMA = 1.2;

/** The deepest the sky ever goes, as an OKLab L. Below the ink ground, so the
    zenith at 3am is fractionally deeper than the app surface under it — the sky
    reads as *behind* the UI rather than level with it. The source agrees: its
    night zenith is genuinely darker than `#0e1117`. */
const LIGHTNESS_FLOOR_OFFSET = -0.014;

/** The cool cast the zenith keeps once the light has gone. The night resolves to
    `#0e1117` — that is the law, and the app's own background is exactly that
    black — but pinning every cell to it as well makes the whole viewport one
    flat fill for the seven hours either side of midnight. A chroma this small is
    invisible as colour and unmistakable as depth. */
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
    both plateaus, so the two halves still meet without a step. The left-right
    flip of the field is the other half of this and is not scaled — a sun does
    not rise partly in the east. */
const DAWN_HUE_ROTATION = (-16 * Math.PI) / 180;
const DAWN_CHROMA_SCALE = 0.86;
const DAWN_LIGHTNESS_SCALE = 1.03;

/** Stars, as thresholds on the SOURCE field's own mean brightness normalised to
    [0, 1] over the clip — not on the output colour.
    Reading them off the output would be circular: the per-keyframe contrast
    clamp needs the star level to decide how light a cell may be, so the star
    level cannot in turn be a function of how light the cells came out. */
const STARS_GONE_ABOVE_SOURCE = 0.32;
const STARS_FULL_BELOW_SOURCE = 0.12;

/** The light theme's wash keeps the hour's hue but inverts its lightness — a
    lightened sky colour lands on grey every time, which reads as a smudge. */
const WASH_LIGHTNESS = 0.918;
const WASH_CHROMA_GAIN = 1.9;
const WASH_CHROMA_CEILING = 0.041;

/* ---------------------------------------------------------------------------
 * The bake — the upscale and the blur, moved off the GPU and into this file.
 *
 * WHAT MOVED, AND WHY. The app used to ship the 20x12 derivation grid and ask
 * the browser to stretch it to the viewport and run `filter: blur(3.6vw)` over
 * the result. So the blur is applied here instead, once, at build time: the
 * shipped image is the blurred result rather than the thing to blur, and the CSS
 * drops `filter` entirely.
 *
 * The first reason was a 210s `scale()` animation on the frame — a filtered
 * layer with a live transform is redrawn, filter and all, on every composited
 * frame, which on a 5504x2304 display held about a quarter of a CPU core in the
 * GPU process, permanently. That animation has since been deleted outright (it
 * was profiled at seventeen points of a core to move the sky by under one
 * percent, and nobody could see it), which retires the argument that motivated
 * this bake.
 *
 * It was therefore re-measured on a static frame, and it still pays: against the
 * same frame carrying `filter: blur(3.6vw)`, the baked image came in about two
 * points of a core cheaper. A filter is not free on a still layer — it forces a
 * render surface that must be composited, and re-rastered on every resize, DPI
 * change and theme flip. Two points held permanently against seventeen kilobytes
 * of gzipped bundle is still the right trade, so the bake stays.
 *
 * WHY THE IMAGE HAD TO GROW. A blur cannot be baked into 20x12. The frame
 * spans 124% of the viewport (the overscan, which the crop now depends on), so one grid cell is
 * 6.2vw and the 3.6vw blur is 0.58 of a cell — a sub-pixel smudge on the grid,
 * while on screen it is the whole softening. Worse, most of what that blur is
 * for does not exist yet at 20x12: it is there to take out the diamond
 * structure the 340x bilinear upscale *creates*. You cannot pre-empt an
 * artefact from downstream of it.
 *
 * The bake therefore does both steps at a resolution where the blur is real —
 * upscale to `BAKE_WIDTH`, blur by the sigma that lands at 3.6vw on screen —
 * and ships that. The browser's remaining upscale is smooth-on-smooth and adds
 * nothing.
 *
 * HOW WIDE. Sigma in baked pixels is `BAKE_WIDTH * BLUR_VW / (100 * OVERSCAN)`,
 * so width and blur quality are the same knob. At sigma 1.39 the sampled image
 * is band-limited far below its own Nyquist — the residual the browser's
 * bilinear reconstruction can miss is under a thousandth of local amplitude,
 * which on a sky that moves a couple of 8-bit levels per cell is nothing. Below
 * about sigma 1.2 the grid starts to reappear under the upscale; above it the
 * bytes buy nothing you can see. 48 is the smallest width that clears the bar
 * with room, and it is where this stops paying.
 *
 * WHAT IT COSTS. Rather more source than the 20x12 did — see FIELD_BUDGET_KB in
 * `derive-starcode-sky-timeline.mjs`, which was raised for exactly this. A
 * one-off pile of bytes against a quarter core held continuously is not a close
 * trade.
 *
 * THE ONE THING THE BAKE GIVES UP. `filter` blurred in screen space, so the
 * softening was isotropic at any window shape. Baked, it is isotropic in the
 * *image*, and the stretch to a window of a different aspect makes it slightly
 * directional — a wide window blurs a little wider than tall. On a formless
 * blurred sky whose gradients are mostly vertical anyway this is not a thing
 * you can see, and it is the price of the layer being static.
 * ------------------------------------------------------------------------ */

/** Frame width as a fraction of the viewport — `inset: -12%` in the stylesheet.
    The overscan the `scale()` push needs; also what sets the blur's scale. */
const FRAME_OVERSCAN = 1.24;
/** The blur the stylesheet used to apply, in vw. Was `--sc-sky-blur`. */
const SCREEN_BLUR_VW = 3.6;
/** Width of the shipped, already-blurred field. See the note above. */
const BAKE_WIDTH = 48;

/** Blur sigma in baked pixels that lands at `SCREEN_BLUR_VW` on screen. */
const BAKE_SIGMA = (BAKE_WIDTH * SCREEN_BLUR_VW) / (100 * FRAME_OVERSCAN);

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

/** The derivation grid — the resolution every colour decision is made at. */
export const fieldSize = () => {
  const { fieldWidth, fieldHeight } = readSource().analysis;
  return { width: fieldWidth, height: fieldHeight };
};

/** The shipped image — the derivation grid, upscaled and blurred. Keeps the
    grid's aspect so the bake introduces no stretch the app was not already
    applying. */
export const bakeSize = () => {
  const { width, height } = fieldSize();
  return { width: BAKE_WIDTH, height: Math.round((BAKE_WIDTH * height) / width) };
};

/** Blur sigma the bake uses, in baked pixels. Exported for the gate's report. */
export const bakeSigma = () => BAKE_SIGMA;

/** One source sample decoded to an array of OKLab cells, row-major. */
const decodedCache = new Map();
function decodeSample(index) {
  let cells = decodedCache.get(index);
  if (cells) return cells;
  const raw = Buffer.from(readSource().samples[index].field, "base64");
  cells = [];
  for (let i = 0; i < raw.length; i += 3) cells.push(rgbToOklab([raw[i], raw[i + 1], raw[i + 2]]));
  decodedCache.set(index, cells);
  return cells;
}

/** Source field at a given `t`, linearly interpolated per cell in OKLab. */
function sampleSource(t) {
  const { samples } = readSource();
  const clamped = Math.min(USABLE_T_END, Math.max(0, t));
  let lower = 0;
  let upper = samples.length - 1;
  for (let i = 0; i < samples.length - 1; i += 1) {
    if (clamped >= samples[i].t && clamped <= samples[i + 1].t) {
      lower = i;
      upper = i + 1;
      break;
    }
  }
  const span = samples[upper].t - samples[lower].t;
  const k = span === 0 ? 0 : (clamped - samples[lower].t) / span;
  const a = decodeSample(lower);
  const b = decodeSample(upper);
  return a.map((cell, i) => cell.map((v, c) => lerp(v, b[i][c], k)));
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
 * The taste transform, per cell.
 * ------------------------------------------------------------------------ */

const warmHue = hexToLch(WARM_ANCHOR)[2];
const coolHue = hexToLch(COOL_ANCHOR)[2];
const groundLch = hexToLch(INK_GROUND);

/** The source's own lightness range, measured once, so the compression below is
    relative to what was actually filmed rather than to a guessed 0..1. */
let cachedRange = null;
function sourceLightnessRange() {
  if (cachedRange) return cachedRange;
  const { samples } = readSource();
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].t > USABLE_T_END) continue;
    for (const cell of decodeSample(i)) {
      min = Math.min(min, cell[0]);
      max = Math.max(max, cell[0]);
    }
  }
  cachedRange = { min, max };
  return cachedRange;
}

/** One source cell to one shipped cell. */
function restyle([L, a, b], ceiling, range) {
  const [, C, h] = toLch([L, a, b]);
  const floor = groundLch[0] + LIGHTNESS_FLOOR_OFFSET;

  // 1. Lightness, compressed into the dark half of the ramp.
  const normalized = clamp01((L - range.min) / (range.max - range.min));
  const outL = lerp(floor, ceiling, normalized ** LIGHTNESS_GAMMA);

  // How far up the ramp this cell sits, used to shape the chroma envelope.
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
 * As the sky runs out of light it converges on the ink ground rather than on the
 * camera's near-black, which sat a long way off the palette in both hue and
 * lightness. The weight is driven by the *output* lightness, so it engages on
 * the strength of the resulting sky rather than on a clock time.
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
  const { width, height } = fieldSize();
  const track = [];
  for (let hour = 0; hour < 24; hour += FINE_STEP_HOURS) {
    const source = sampleSource(hourToSourceT(hour));
    const dawn = dawnWeight(hour);
    const morning = isMorning(hour);
    const cells = source.map((lab, index) => {
      const row = Math.floor(index / width);
      // The left-right mirror. Exact, free, and the strongest cue that dawn is
      // not dusk played backwards: the glow that set in the west rises in the
      // east. Applied by reading the source from the mirrored column.
      const from = morning ? source[row * width + (width - 1 - (index % width))] : lab;
      let out = restyle(from, ceiling, range);
      if (dawn > 0) {
        // Cooler, cleaner, a touch brighter aloft. Scaled by the bump so both
        // plateaus still meet without a step.
        const [L, C, h] = toLch(out);
        const upper = 1 - row / (height - 1);
        out = fromLch([
          L * lerp(1, DAWN_LIGHTNESS_SCALE, dawn * upper),
          C * lerp(1, DAWN_CHROMA_SCALE, dawn),
          h + DAWN_HUE_ROTATION * dawn,
        ]);
      }
      return anchorToGround(out, ceiling);
    });
    track.push(cells);
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
    track[i].map((_, cell) => {
      const acc = [0, 0, 0];
      weights.forEach((w, k) => {
        const j = (i + k - radius + track.length * 2) % track.length;
        for (let c = 0; c < 3; c += 1) acc[c] += track[j][cell][c] * w;
      });
      return acc.map((v) => v / total);
    }),
  );
}

/* ---------------------------------------------------------------------------
 * The derived scalars: stars, the top colour, the light theme's wash.
 * ------------------------------------------------------------------------ */

/** Source field mean brightness at an hour, normalised over the whole clip. */
function sourceBrightness(hour) {
  const range = sourceLightnessRange();
  const cells = sampleSource(hourToSourceT(hour));
  const mean = cells.reduce((a, c) => a + c[0], 0) / cells.length;
  return clamp01((mean - range.min) / (range.max - range.min));
}

function starsFor(hour) {
  const n = sourceBrightness(hour);
  return Number(
    smoothstep(
      (STARS_GONE_ABOVE_SOURCE - n) / (STARS_GONE_ABOVE_SOURCE - STARS_FULL_BELOW_SOURCE),
    ).toFixed(3),
  );
}

/** The average of the field's top row. This is the colour at the top of the
    window, which is what the browser and native titlebars should match and what
    the sky layer paints under the field. */
function topFor(cells) {
  const { width } = fieldSize();
  const acc = [0, 0, 0];
  for (let x = 0; x < width; x += 1) for (let c = 0; c < 3; c += 1) acc[c] += cells[x][c];
  return rgbToHex(oklabToRgb(acc.map((v) => v / width)));
}

function washFor(cells) {
  // Whichever cell carries the hour's colour most strongly. Taking the most
  // chromatic rather than the average is why the light theme warms at dusk and
  // cools at noon without a second table.
  let best = cells[0];
  let bestC = -1;
  for (const cell of cells) {
    const C = toLch(cell)[1];
    if (C > bestC) {
      bestC = C;
      best = cell;
    }
  }
  const [, C, h] = toLch(best);
  return rgbToHex(
    oklabToRgb(fromLch([WASH_LIGHTNESS, Math.min(WASH_CHROMA_CEILING, C * WASH_CHROMA_GAIN), h])),
  );
}

/* ---------------------------------------------------------------------------
 * The bake: upscale, then blur. Both in sRGB, because that is where CSS did it.
 *
 * `filter: blur()` operates on non-linear sRGB values — correct or not, it is
 * what shipped and what the palette was judged against, so blurring in linear
 * light here would quietly relight every keyframe. The point of this stage is
 * to produce the pixels the GPU was producing, not better ones.
 * ------------------------------------------------------------------------ */

/**
 * Bilinear resample, sampling at texel centres — the same reconstruction the
 * browser applies to a stretched background, so the bake starts from the image
 * the upscale was already producing.
 */
function resampleBilinear(rgb, from, to) {
  const out = new Float64Array(to.width * to.height * 3);
  const axis = (i, dst, src) => {
    const s = Math.min(src - 1, Math.max(0, ((i + 0.5) * src) / dst - 0.5));
    const low = Math.floor(s);
    return { low, high: Math.min(src - 1, low + 1), t: s - low };
  };

  for (let y = 0; y < to.height; y += 1) {
    const v = axis(y, to.height, from.height);
    for (let x = 0; x < to.width; x += 1) {
      const h = axis(x, to.width, from.width);
      for (let c = 0; c < 3; c += 1) {
        const at = (row, col) => rgb[(row * from.width + col) * 3 + c];
        const top = at(v.low, h.low) * (1 - h.t) + at(v.low, h.high) * h.t;
        const bottom = at(v.high, h.low) * (1 - h.t) + at(v.high, h.high) * h.t;
        out[(y * to.width + x) * 3 + c] = top * (1 - v.t) + bottom * v.t;
      }
    }
  }
  return out;
}

/**
 * Separable Gaussian with the edges clamped rather than transparent.
 *
 * This is the one place the bake deliberately differs from what the GPU did.
 * `filter` samples transparency past the element and darkens the whole radius
 * inward, which is half of why the frame overscans at all; clamping extends the
 * edge colour instead and produces no rim to hide. The overscan stays — the
 * `scale()` push still needs it — but it no longer has a dark edge to cover.
 */
function gaussianBlur(buf, size, sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let total = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(weight);
    total += weight;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= total;

  const pass = (src, horizontal) => {
    const dst = new Float64Array(src.length);
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          let acc = 0;
          for (let k = -radius; k <= radius; k += 1) {
            const sx = horizontal ? Math.min(size.width - 1, Math.max(0, x + k)) : x;
            const sy = horizontal ? y : Math.min(size.height - 1, Math.max(0, y + k));
            acc += src[(sy * size.width + sx) * 3 + c] * kernel[k + radius];
          }
          dst[(y * size.width + x) * 3 + c] = acc;
        }
      }
    }
    return dst;
  };

  return pass(pass(buf, true), false);
}

/** The derivation grid, as the blurred image the app actually paints. */
function bakeField(rgb) {
  const from = fieldSize();
  const to = bakeSize();
  const blurred = gaussianBlur(resampleBilinear(rgb, from, to), to, BAKE_SIGMA);
  const out = Buffer.alloc(to.width * to.height * 3);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.min(255, Math.max(0, Math.round(blurred[i])));
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * PNG, by hand, with an Up filter and a real deflate.
 *
 * No dependency, and until the bake landed no compression either: the field was
 * 240 pixels and STORED blocks made `--check` byte-identical everywhere, since
 * `zlib.deflateSync` output can differ between zlib builds. That is no longer
 * affordable. The baked field is a hundred and sixteen times the pixels, and
 * stored blocks put it past 200KB of module source — an order out.
 *
 * So: deflate, at pinned settings, over rows filtered against the row above.
 * The image is a vertical gradient by construction, which is precisely what an
 * Up filter is for — it takes the payload to roughly a third of what filtering
 * none does, and unlike per-row filter selection it costs the decoder four
 * lines rather than forty. Adaptive selection was measured at about 6KB better
 * and is not worth what it makes this file.
 *
 * `--check` no longer requires the bytes to match, only the pixels — see the
 * gate in `derive-starcode-sky-timeline.mjs`. That keeps the invariant that
 * matters (the shipped table is a derivation, not a hand-edited snapshot)
 * without failing a colleague's build over a zlib revision.
 * ------------------------------------------------------------------------ */

/** Pinned so a given zlib produces one answer; see the note on `--check`. */
const DEFLATE_OPTIONS = { level: 9, windowBits: 15, memLevel: 8 };
/** PNG filter type 2: each byte carried as its delta from the row above. */
const FILTER_UP = 2;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Scanlines as PNG rows: filter byte, then this row minus the one above. */
function filterRows(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = FILTER_UP;
    for (let i = 0; i < stride; i += 1) {
      const above = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      raw[y * (1 + stride) + 1 + i] = (rgb[y * stride + i] - above) & 0xff;
    }
  }
  return raw;
}

/** The inverse, for the round-trip guard and the contrast gate. */
function unfilterRows(raw, width, height) {
  const stride = width * 3;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (1 + stride)] !== FILTER_UP) return null;
    for (let i = 0; i < stride; i += 1) {
      const above = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      rgb[y * stride + i] = (raw[y * (1 + stride) + 1 + i] + above) & 0xff;
    }
  }
  return rgb;
}

function encodePng(width, height, rgb) {
  const idat = NodeZlib.deflateSync(filterRows(width, height, rgb), DEFLATE_OPTIONS);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The IDAT payload of a PNG this module wrote. */
function idatOf(png) {
  const start = 8 + 25; // signature + IHDR chunk
  const length = png.readUInt32BE(start);
  return png.subarray(start + 8, start + 8 + length);
}

/** Round-trip guard: node's own inflate has to accept what we hand the browser. */
export function verifyPng(png, width, height, rgb) {
  const raw = NodeZlib.inflateSync(idatOf(png));
  if (raw.length !== height * (1 + width * 3)) return false;
  const decoded = unfilterRows(raw, width, height);
  return decoded !== null && decoded.equals(rgb);
}

/**
 * Decode a shipped keyframe's field back to RGB cells, for the gates.
 *
 * These are baked cells, not derivation cells — so the contrast gate now reads
 * the pixels that reach the screen rather than the grid they were solved on.
 * That is strictly the better thing to measure: the blur pulls every extreme
 * toward its neighbours, so the old gate was holding the sky to a worst case
 * the viewer was never shown.
 */
export function decodeField(dataUri) {
  const png = Buffer.from(dataUri.slice("data:image/png;base64,".length), "base64");
  const { width, height } = bakeSize();
  const rgb = unfilterRows(NodeZlib.inflateSync(idatOf(png)), width, height);
  if (rgb === null)
    throw new Error("field PNG is not Up-filtered — was it written by this module?");
  const cells = [];
  for (let i = 0; i < width * height; i += 1) {
    cells.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
  }
  return cells;
}

/* ---------------------------------------------------------------------------
 * Contrast helpers, shared with the gate.
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

/** The only token that lands on the bare sky — the pairing screen's cream. */
export const RAW_SKY_TEXT = "#eadcc6"; // --foreground
/** The tightest token anywhere. The gate holds it against the panel composite. */
export const TIGHTEST_DARK_TEXT = "#c7b8a1"; // --muted-foreground
export const STAR_TINT = "#eadcc6";
export const STAR_CHROME_MAX = 0.26;
export const BRIGHTEST_STAR_IN_TILE = 0.86;
/** Margin over AA. The gate holds 4.5; the clamp leaves headroom so a later
    palette nudge does not immediately break the sky. */
export const SOLVE_FLOOR = 4.7;

/* ------------------------------------------------------------------------ */

function gridHours() {
  const hours = [];
  for (const [from, to, step] of GRID_SEGMENTS) {
    for (let h = from; h < to; h += step) hours.push(Number(h.toFixed(2)));
  }
  if (hours[hours.length - 1] !== 24) hours.push(24);
  return hours;
}

/** Counters for `--check`, reset at the top of every `buildTimeline`. */
let clampedCells = 0;
let totalCells = 0;
export const clampReport = () => ({ clamped: clampedCells, total: totalCells });

/**
 * Hold one cell to the contrast floor, given its keyframe's star level.
 *
 * Only lightness moves — hue and chroma are what the taste transform decided and
 * are none of this function's business. Bisected on the real composited colour
 * rather than on a luminance approximation, because at these chromas the
 * approximation is wrong by enough to matter at the floor.
 *
 * The token held here is `--foreground`, not `--muted-foreground`. That is not a
 * relaxation, it is the correct audit: the raw sky is only ever behind text on
 * the pairing screen, and the tightest thing there is the cream foreground.
 * Every other surface reads the sky through a structural panel, which is darker
 * than the sky and therefore raises contrast — and which
 * `check-starcode-contrast.mjs` verifies separately at the panel's own tint.
 * Holding the body token here instead is what made the first version's daylight
 * two stops darker than it needed to be.
 */
function holdContrast(lab, stars) {
  const [L, C, h] = toLch(lab);
  const holds = (candidate) => {
    const hex = rgbToHex(oklabToRgb(fromLch([candidate, C, h])));
    const lit =
      stars > 0
        ? compositeOver(STAR_TINT, stars * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, hex)
        : hex;
    return contrastRatio(RAW_SKY_TEXT, lit) >= SOLVE_FLOOR;
  };

  totalCells += 1;
  if (holds(L)) return lab;

  clampedCells += 1;
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
 * Build the shipped table.
 *
 * Returns keyframes of `{ hour, field, top, wash, stars }`. `field` is a
 * `data:image/png` URI of the tiny colour grid; the app scales it to the
 * viewport and blurs it. The last keyframe is hour 24 and is identical to hour 0
 * by construction, so the day wraps without a step at midnight.
 */
export function buildTimeline(ceiling = LIGHTNESS_CEILING) {
  const { width, height } = fieldSize();
  const smoothed = smoothTrack(buildFineTrack(ceiling));
  const at = (hour) => {
    const index = Math.round((((hour % 24) + 24) % 24) / FINE_STEP_HOURS) % smoothed.length;
    return smoothed[index];
  };

  clampedCells = 0;
  totalCells = 0;

  return gridHours().map((hour) => {
    const stars = starsFor(hour);
    const cells = at(hour).map((lab) => holdContrast(lab, stars));

    const rgb = Buffer.alloc(width * height * 3);
    cells.forEach((lab, i) => {
      const [r, g, b] = oklabToRgb(lab);
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    });

    // Everything above is the derivation, at the grid it was solved on.
    // Everything the app sees is the bake — see the note beside BAKE_WIDTH.
    const baked = bakeField(rgb);
    const size = bakeSize();
    const png = encodePng(size.width, size.height, baked);
    if (!verifyPng(png, size.width, size.height, baked)) {
      throw new Error(`PNG round-trip failed at ${hour}h`);
    }

    return {
      hour,
      field: `data:image/png;base64,${png.toString("base64")}`,
      top: topFor(cells),
      wash: washFor(cells),
      stars,
    };
  });
}

/** Worst contrast on the BARE sky across a whole timeline. */
export function worstSkyContrast(timeline) {
  let worst = Infinity;
  let where = null;
  for (const frame of timeline) {
    for (const [index, cell] of decodeField(frame.field).entries()) {
      const hex = rgbToHex(cell);
      const lit =
        frame.stars > 0
          ? compositeOver(STAR_TINT, frame.stars * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, hex)
          : hex;
      for (const surface of [hex, lit]) {
        const r = contrastRatio(RAW_SKY_TEXT, surface);
        if (r < worst) {
          worst = r;
          where = { hour: frame.hour, cell: index, surface };
        }
      }
    }
  }
  return { ratio: worst, where };
}

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

export { LIGHTNESS_CEILING };
export const SOURCE_META = () => readSource();
