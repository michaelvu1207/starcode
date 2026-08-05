/**
 * Stage A — pull the time-lapse's colour script out of the video, as a series of
 * tiny 2D colour fields.
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
 * WHY A FIELD AND NOT A GRADIENT — the correction that produced this version.
 * The first version of this reduced each frame to six vertical colour stops by
 * taking the MEDIAN ACROSS X of every row. That is a good estimator and it is
 * the wrong measurement: a median across x is defined by discarding horizontal
 * structure, and horizontal structure is where a sky keeps its cloud masses, its
 * off-centre glow, and every patch of colour that is not the average of its
 * latitude. Six vertical stops can only ever render as a gradient, and it did —
 * the review was "it just looks like a simple gradient, there should be some
 * dimensionality". So this emits a small 2D grid instead, and the app upscales
 * and blurs it, which is as close to "we blurred the video" as you can get
 * without playing the video.
 *
 * WHAT REPLACED THE MEDIAN, since the artefacts it rejected are still there.
 * Box averaging at this scale does the same job by a different route. Each cell
 * of the grid covers roughly 96x90 source pixels, so the sun's disc contributes
 * a few percent of one cell — it warms the cell, which is correct, rather than
 * defining it. The city lights along the horizon average into a dim glow, which
 * is what they look like from a distance anyway. What box averaging does NOT
 * handle is a transient, so the +/-2 frame temporal median stays exactly where
 * it was. Nothing that happens in one frame of the source can reach a keyframe.
 */

import * as NodeChildProcess from "node:child_process";

/** Decode raster. Detection wants rows; the field is box-averaged down from it. */
const W = 96;
const H = 144;
const FPS = 5;

/**
 * Field size. Big enough for cloud masses and an asymmetric glow to survive,
 * small enough that no upscale can reveal photographic detail or sensor noise —
 * at 20 columns one cell is about a twentieth of the sky, which after a 70x
 * upscale is a soft shape and cannot be anything else. It is also the whole
 * bundle cost: the shipped module carries one PNG per keyframe.
 */
const FIELD_W = 20;
const FIELD_H = 12;

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

const at = (f, x, y, c) => buf[f * frameBytes + (y * W + x) * 3 + c];

/* Temporal median per pixel, +/-2 frames. This is what kills the encoder's
   exposure staircase (the source is an AV1 re-encode of an already-compressed
   upload and its luminance steps by ~2% at scene cuts) and anything else that
   lives for a single frame. */
const frames = [];
for (let f = 0; f < frameCount; f += 1) {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        const window = [];
        for (let d = -2; d <= 2; d += 1) {
          window.push(at(Math.min(frameCount - 1, Math.max(0, f + d)), x, y, c));
        }
        out[(y * W + x) * 3 + c] = median(window);
      }
    }
  }
  frames.push(out);
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const rowLum = (frame, y) => {
  let acc = 0;
  for (let x = 0; x < W; x += 1) {
    const p = (y * W + x) * 3;
    acc += lum(frame[p], frame[p + 1], frame[p + 2]);
  }
  return acc / W;
};

/* Letterbox first. The upload is pillar-boxed into 16:9 with hard black bars,
   and a bar row is a perfect zero in EVERY frame — including the bright opening,
   which is what distinguishes it from the genuinely black night sky at the end.
   Missing this puts a band of pure black across the top of every field. */
const rowMax = Array.from({ length: H }, () => 0);
for (const frame of frames) {
  for (let y = 0; y < H; y += 1) rowMax[y] = Math.max(rowMax[y], rowLum(frame, y));
}
let top = 0;
while (top < H && rowMax[top] < 4) top += 1;
let bottom = H - 1;
while (bottom > top && rowMax[bottom] < 4) bottom -= 1;
console.error(`picture rows ${top}..${bottom} (letterbox trimmed)`);

/* Horizon: the camera is locked, so it is one row for the whole clip. Found as
   the row with the largest sustained luminance step, searched only in the lower
   half of the picture, summed over the frames bright enough to have a visible
   edge at all. Everything below it is ground — trees and a town — which the app
   never claimed to reproduce and which would put a hard dark band across the
   bottom of every field. */
const stepScore = Array.from({ length: H }, () => 0);
const searchFrom = top + Math.floor((bottom - top) * 0.5);
for (const frame of frames) {
  if (rowLum(frame, top + 2) < 20) continue; // too dark to locate an edge
  for (let y = searchFrom; y < bottom - 2; y += 1) {
    stepScore[y] += Math.max(0, rowLum(frame, y - 2) - rowLum(frame, y + 2));
  }
}
let horizon = searchFrom;
for (let y = 0; y < H; y += 1) if (stepScore[y] > stepScore[horizon]) horizon = y;
console.error(
  `horizon row ${horizon} (${(((horizon - top) / (bottom - top)) * 100).toFixed(1)}% down the picture)`,
);

/* The sky region, box-averaged into the field. The last row stops 2 short of the
   horizon so no ground pixel can leak into it. */
const skyTop = top;
const skyBottom = horizon - 2;

function fieldFor(frame) {
  const out = Buffer.alloc(FIELD_W * FIELD_H * 3);
  for (let fy = 0; fy < FIELD_H; fy += 1) {
    const y0 = skyTop + Math.round(((skyBottom - skyTop + 1) * fy) / FIELD_H);
    const y1 = skyTop + Math.round(((skyBottom - skyTop + 1) * (fy + 1)) / FIELD_H);
    for (let fx = 0; fx < FIELD_W; fx += 1) {
      const x0 = Math.round((W * fx) / FIELD_W);
      const x1 = Math.round((W * (fx + 1)) / FIELD_W);
      const acc = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < Math.max(y0 + 1, y1); y += 1) {
        for (let x = x0; x < Math.max(x0 + 1, x1); x += 1) {
          const p = (y * W + x) * 3;
          acc[0] += frame[p];
          acc[1] += frame[p + 1];
          acc[2] += frame[p + 2];
          n += 1;
        }
      }
      const q = (fy * FIELD_W + fx) * 3;
      for (let c = 0; c < 3; c += 1) out[q + c] = Math.round(acc[c] / n);
    }
  }
  return out;
}

/* 97 evenly spaced samples — half a second apart, dense enough that the
   derivation can resample any hour without inventing detail. */
const SAMPLES = 97;
const samples = [];
for (let s = 0; s < SAMPLES; s += 1) {
  const t = s / (SAMPLES - 1);
  const f = Math.min(frameCount - 1, Math.round(t * (frameCount - 1)));
  samples.push({ t: Number(t.toFixed(4)), field: fieldFor(frames[f]).toString("base64") });
}

process.stdout.write(
  `${JSON.stringify(
    {
      source: "https://www.youtube.com/watch?v=qJiopi3GbFw",
      note:
        "GENERATED. Day-to-night time-lapse. Each sample is a base64 RGB grid of the SKY region only " +
        "(letterbox and ground cropped), box-averaged from a temporally median-filtered decode. " +
        "Row-major, 3 bytes per cell. Method and re-run instructions: extract-starcode-sky-source.mjs.",
      video: {
        width: 1920,
        height: 1080,
        durationSeconds: 48.548,
        sampledFps: FPS,
        frames: frameCount,
      },
      analysis: {
        rasterWidth: W,
        rasterHeight: H,
        pictureRows: [top, bottom],
        horizonRow: horizon,
        fieldWidth: FIELD_W,
        fieldHeight: FIELD_H,
      },
      samples,
    },
    null,
    2,
  )}\n`,
);
console.error(`emitted ${SAMPLES} fields at ${FIELD_W}x${FIELD_H}`);
