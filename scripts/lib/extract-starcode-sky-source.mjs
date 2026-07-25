/**
 * Stage A — pull a vertical gradient signature out of the time-lapse.
 *
 * This is the one step that needs the video. Its output,
 * `starcode-sky-source.json`, is committed; from there
 * `derive-starcode-sky-timeline.mjs` takes over, so rebuilding the sky needs
 * neither ffmpeg nor a download. This script is here so the measurement is
 * reproducible rather than merely asserted — `starcode-sky-source.json` is
 * data about the world, and data about the world without its method is a
 * magic number with more digits.
 *
 * To re-run it (requires `yt-dlp` and `ffmpeg`):
 *
 *   yt-dlp -f 'bv*[height<=1080]+ba/b' -o source.webm \
 *     'https://www.youtube.com/watch?v=qJiopi3GbFw'
 *   node scripts/lib/extract-starcode-sky-source.mjs > starcode-sky-source.json
 *
 * with `source.webm` beside this file. Keep the video out of the repo. The
 * committed JSON has been through `vp fmt` since, so it differs from this
 * script's raw output in whitespace only — compare parsed, not byte for byte.
 *
 * Method, and why each choice rejects a specific artefact:
 *   - ffmpeg decodes to raw rgb24 at 96x144, so there is no PNG decoder here and
 *     no dependency. Aspect is deliberately not preserved: rows are all we want,
 *     and 144 rows off a 1080p source is a clean 7.5:1 box filter.
 *   - Per row we take the MEDIAN across x, never the mean. The sun disc, its
 *     lens flare, and the city lights on the ground are all narrow in x; a mean
 *     lets them drag the row, a median does not see them at all. This is the
 *     "a passing car's headlights must not become a keyframe" rule, applied at
 *     the earliest possible stage.
 *   - Then a temporal median over a +/-2 frame window, which kills the
 *     encoder's exposure steps (the source is a 4.9MB AV1 re-encode of an
 *     already-compressed upload; its luminance staircases by ~2% at scene cuts).
 */

import * as NodeChildProcess from "node:child_process";

const W = 96;
const H = 144;
const FPS = 5;
const SRC = new URL("./source.webm", import.meta.url).pathname;

const ff = NodeChildProcess.spawnSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    SRC,
    "-an",
    "-vf",
    `fps=${FPS},scale=${W}:${H}:flags=lanczos`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ],
  { maxBuffer: 1 << 30 },
);
if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr}`);

const buf = ff.stdout;
const frameBytes = W * H * 3;
const frameCount = Math.floor(buf.length / frameBytes);
console.error(`decoded ${frameCount} frames (${W}x${H})`);

/** Median of a numeric array, in place. */
function median(values) {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** rows[frame][row] = [r, g, b], each the median across x. */
const rows = [];
for (let f = 0; f < frameCount; f += 1) {
  const base = f * frameBytes;
  const frame = [];
  for (let y = 0; y < H; y += 1) {
    const r = [],
      g = [],
      b = [];
    for (let x = 0; x < W; x += 1) {
      const p = base + (y * W + x) * 3;
      r.push(buf[p]);
      g.push(buf[p + 1]);
      b.push(buf[p + 2]);
    }
    frame.push([median(r), median(g), median(b)]);
  }
  rows.push(frame);
}

/* Temporal median, +/-2 frames. */
const smoothed = rows.map((_, f) =>
  rows[f].map((_, y) => {
    const out = [];
    for (let c = 0; c < 3; c += 1) {
      const window = [];
      for (let d = -2; d <= 2; d += 1) {
        const i = Math.min(frameCount - 1, Math.max(0, f + d));
        window.push(rows[i][y][c]);
      }
      out.push(median(window));
    }
    return out;
  }),
);

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/* Letterbox first. The upload is pillar-boxed into 16:9 with hard black bars,
   and a bar row is a perfect zero in EVERY frame — including the bright opening,
   which is what distinguishes it from the genuinely black night sky at the end.
   Missing this puts a row of pure black into the zenith band and drags the whole
   daytime ramp toward the ink floor before the taste transform ever runs. */
const rowMax = Array.from({ length: H }, () => 0);
for (let f = 0; f < frameCount; f += 1) {
  for (let y = 0; y < H; y += 1) rowMax[y] = Math.max(rowMax[y], lum(smoothed[f][y]));
}
let top = 0;
while (top < H && rowMax[top] < 4) top += 1;
let bottom = H - 1;
while (bottom > top && rowMax[bottom] < 4) bottom -= 1;
console.error(`picture rows ${top}..${bottom} (letterbox trimmed)`);

/* Horizon: the camera is locked, so it is one row for the whole clip. Find it as
   the row with the largest sustained luminance step, searched only in the lower
   half of the picture, summed over the frames bright enough to have a visible
   edge at all. */
const stepScore = Array.from({ length: H }, () => 0);
const searchFrom = top + Math.floor((bottom - top) * 0.5);
for (let f = 0; f < frameCount; f += 1) {
  const frameLum = smoothed[f].map(lum);
  if (frameLum[top + 2] < 20) continue; // too dark to locate an edge
  for (let y = searchFrom; y < bottom - 2; y += 1) {
    stepScore[y] += Math.max(0, frameLum[y - 2] - frameLum[y + 2]);
  }
}
let horizon = searchFrom;
for (let y = 0; y < H; y += 1) if (stepScore[y] > stepScore[horizon]) horizon = y;
console.error(
  `horizon row ${horizon} (${(((horizon - top) / (bottom - top)) * 100).toFixed(1)}% down the picture)`,
);

/* Six bands across the sky region only, from zenith to just above the horizon.
   The last band stops 2 rows short so no ground pixel can leak into it. */
const BANDS = 6;
const skyTop = top;
const skyBottom = horizon - 2;
const bands = [];
for (let i = 0; i < BANDS; i += 1) {
  const centre = skyTop + (i / (BANDS - 1)) * (skyBottom - skyTop);
  const half = Math.max(1.5, (skyBottom - skyTop) / (BANDS * 2));
  bands.push([
    Math.max(skyTop, Math.round(centre - half)),
    Math.min(skyBottom, Math.round(centre + half)),
  ]);
}

/* The sun's horizontal position, for the directional-light anchor. Taken from
   the ORIGINAL per-x data in the band just above the horizon: argmax of a
   box-blurred luminance profile, which finds the blaze rather than a hot pixel.
   Reported with a confidence so the transform can ignore it when the sky is
   flat (overcast opening, and every frame after dark). */
const sunTrack = [];
for (let f = 0; f < frameCount; f += 1) {
  const base = f * frameBytes;
  const y0 = Math.max(0, horizon - 18);
  const y1 = Math.max(1, horizon - 3);
  const profile = Array.from({ length: W }, () => 0);
  for (let x = 0; x < W; x += 1) {
    let acc = 0;
    for (let y = y0; y < y1; y += 1) {
      const p = base + (y * W + x) * 3;
      acc += lum([buf[p], buf[p + 1], buf[p + 2]]);
    }
    profile[x] = acc / (y1 - y0);
  }
  const blur = profile.map((_, x) => {
    let acc = 0,
      n = 0;
    for (let d = -4; d <= 4; d += 1) {
      const i = x + d;
      if (i >= 0 && i < W) {
        acc += profile[i];
        n += 1;
      }
    }
    return acc / n;
  });
  let peak = 0;
  for (let x = 0; x < W; x += 1) if (blur[x] > blur[peak]) peak = x;
  const mean = blur.reduce((a, b) => a + b, 0) / W;
  sunTrack.push({
    x: Number((peak / (W - 1)).toFixed(4)),
    // How much the peak stands above the band's own average: a real sun is a
    // big number, an even overcast or a dark sky is near zero.
    confidence: Number(Math.max(0, (blur[peak] - mean) / Math.max(1, mean)).toFixed(4)),
  });
}

/* Reduce to 97 evenly spaced samples — dense enough that the derivation script
   can resample anywhere without inventing detail, small enough to read. */
const SAMPLES = 97;
const samples = [];
for (let s = 0; s < SAMPLES; s += 1) {
  const t = s / (SAMPLES - 1);
  const f = Math.min(frameCount - 1, Math.round(t * (frameCount - 1)));
  const stops = bands.map(([a, b]) => {
    const acc = [0, 0, 0];
    for (let y = a; y <= b; y += 1) for (let c = 0; c < 3; c += 1) acc[c] += smoothed[f][y][c];
    const n = b - a + 1;
    return acc.map((v) => Math.round(v / n));
  });
  samples.push({
    t: Number(t.toFixed(4)),
    stops,
    sunX: sunTrack[f].x,
    sunConfidence: sunTrack[f].confidence,
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      source: "https://www.youtube.com/watch?v=qJiopi3GbFw",
      note: "GENERATED. Day-to-night time-lapse, per-row medians across x, banded from zenith to horizon. Method and re-run instructions: extract-starcode-sky-source.mjs.",
      video: {
        width: 1920,
        height: 1080,
        durationSeconds: 48.548,
        sampledFps: FPS,
        frames: frameCount,
      },
      analysis: { rasterWidth: W, rasterHeight: H, horizonRow: horizon, bands },
      samples,
    },
    null,
    2,
  )}\n`,
);
console.error(`emitted ${SAMPLES} samples`);
