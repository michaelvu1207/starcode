/**
 * Regenerates `apps/web/src/starcodeSkyTimeline.ts` from the time-lapse's
 * measured colour script.
 *
 *   node scripts/derive-starcode-sky-timeline.mjs           # write the module
 *   node scripts/derive-starcode-sky-timeline.mjs --check   # verify it is in sync
 *   node scripts/derive-starcode-sky-timeline.mjs --print   # the table, as a table
 *
 * The transform, and every taste decision in it, lives in
 * `scripts/lib/starcode-sky-timeline.mjs`. This file is only the plumbing: it
 * calls that, formats a TypeScript module, and holds the result to five
 * invariants — the deepest night lands on the kit's black, midnight wraps
 * without a step, the contrast clamp is bounding the sky rather than composing
 * it, every cell clears AA on the bare sky, and the shipped module is not
 * larger than the budget.
 *
 * `--check` is the same shape as `derive-starcode-star-layers.mjs --check`, and
 * for the same reason: the shipped table has to stay a *derivation* of the
 * source rather than a snapshot of one. Hand-editing a field in the generated
 * module would work, look fine, and silently detach the sky from the video it is
 * supposed to be a recreation of.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  LIGHTNESS_CEILING,
  SOURCE_META,
  SUNRISE_HOUR,
  SUNSET_HOUR,
  buildTimeline,
  clampReport,
  contrastRatio,
  decodeField,
  fieldSize,
  phaseForHour,
  rgbToHex,
  worstSkyContrast,
} from "./lib/starcode-sky-timeline.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outputPath = NodePath.resolve(here, "..", "apps", "web", "src", "starcodeSkyTimeline.ts");

/** The kit's ground. The deepest keyframe has to land on it. */
const INK_GROUND = "#0e1117";
/** How far the darkest sky may sit from the ground, as a contrast ratio. 1.08
    is imperceptible as a colour difference and generous enough to allow the
    zenith its cool cast. */
const NIGHT_GROUND_TOLERANCE = 1.08;
/** Bundle budget for the field images, in KB of module source. One PNG per
    keyframe is the whole cost of the backdrop; past this it stops being a
    background and starts being an asset. */
const FIELD_BUDGET_KB = 56;

function formatModule(timeline) {
  const meta = SOURCE_META();
  const { width, height } = fieldSize();
  const rows = timeline
    .map((frame) =>
      [
        "  {",
        `    hour: ${frame.hour},`,
        `    name: "${phaseForHour(frame.hour)}",`,
        `    top: "${frame.top}",`,
        `    wash: "${frame.wash}",`,
        `    stars: ${frame.stars},`,
        `    field:`,
        `      "${frame.field}",`,
        "  },",
      ].join("\n"),
    )
    .join("\n");

  return `/**
 * GENERATED — do not edit. Run:
 *
 *   node scripts/derive-starcode-sky-timeline.mjs
 *
 * The sky's colour script, measured off a day-to-night time-lapse and restyled
 * into this palette. ${meta.source}
 *
 * Each keyframe is one moment on the local clock. \`field\` is a ${width}x${height}
 * PNG of the sky at that hour — small enough that no upscale can reveal
 * photographic detail, large enough to keep cloud masses and an asymmetric glow.
 * The app stretches it to the viewport and blurs it, which is as close to "we
 * blurred the video" as you can get without playing the video.
 *
 * \`top\` is the average of the field's top row, for the titlebar tint and the
 * layer's own base colour. \`wash\` is the light theme's paper tint. \`stars\`
 * scales the chrome starfield. \`starcodeSky.ts\` crossfades between adjacent
 * keyframes every minute; \`starcode-theme.css\` paints them.
 *
 * WHAT YOU CANNOT FIX BY EDITING THIS FILE. Nothing here was chosen — the
 * colours come from the footage, the compression that made them usable is in
 * \`scripts/lib/starcode-sky-timeline.mjs\`, and every taste knob is a named
 * constant at the top of that file. Change the knob and re-run. A field edited
 * here survives exactly until the next person runs the generator, and
 * \`--check\` fails in the meantime.
 *
 * Sunrise ${SUNRISE_HOUR}, sunset ${SUNSET_HOUR}, fixed rather than geolocated.
 * Hour 24 is hour 0, so the day wraps without a step at midnight.
 */

export interface SkyKeyframe {
  /** Local hour, 0-24. Ascending, first is 0, last is 24. */
  readonly hour: number;
  readonly name: SkyPhaseName;
  /** Average of the field's top row — the colour at the top of the window. */
  readonly top: string;
  /** The light theme's tint for this hour. */
  readonly wash: string;
  /** Star field opacity, 0 to 1. */
  readonly stars: number;
  /** ${width}x${height} PNG data URI. Upscaled to the viewport and blurred. */
  readonly field: string;
}

export type SkyPhaseName = "night" | "dawn" | "day" | "dusk";

export const SKY_FIELD_WIDTH = ${width};
export const SKY_FIELD_HEIGHT = ${height};

export const SKY_TIMELINE: readonly SkyKeyframe[] = [
${rows}
];
`;
}

const timeline = buildTimeline(LIGHTNESS_CEILING);
const generated = formatModule(timeline);

if (process.argv.includes("--print")) {
  const { width } = fieldSize();
  for (const frame of timeline) {
    const cells = decodeField(frame.field);
    // The corners and the middle: enough to see the arc and the asymmetry.
    const sample = [
      0,
      width - 1,
      Math.floor(cells.length / 2),
      cells.length - width,
      cells.length - 1,
    ]
      .map((i) => rgbToHex(cells[i]))
      .join(" ");
    console.log(
      String(frame.hour).padStart(5),
      phaseForHour(frame.hour).padEnd(5),
      `top ${frame.top}`,
      `stars ${String(frame.stars).padEnd(5)}`,
      `wash ${frame.wash}`,
      `| TL TR C BL BR ${sample}`,
    );
  }
  process.exit(0);
}

/* The invariants worth failing on, checked in both modes. */
const problems = [];

const darkest = timeline.reduce((a, b) => (a.stars >= b.stars && a.top <= b.top ? a : b));
const groundDelta = contrastRatio(darkest.top, INK_GROUND);
if (groundDelta > NIGHT_GROUND_TOLERANCE) {
  problems.push(
    `the deepest night (${darkest.top} at ${darkest.hour}h) sits ${groundDelta.toFixed(3)}:1 ` +
      `off ${INK_GROUND}, past the ${NIGHT_GROUND_TOLERANCE} tolerance. The palette is anchored ` +
      `on that black; the sky does not get to drift off it.`,
  );
}

if (timeline[0].field !== timeline[timeline.length - 1].field) {
  problems.push("hour 0 and hour 24 differ, so the sky steps at midnight");
}

const { clamped, total } = clampReport();
if (clamped / total > 0.35) {
  problems.push(
    `${clamped} of ${total} field cells are pinned to the contrast floor. Past about a third, ` +
      "the clamp is composing the sky rather than bounding it, and the starlit hours all " +
      "flatten onto one lightness. Lower LIGHTNESS_CEILING or raise LIGHTNESS_GAMMA.",
  );
}

const worst = worstSkyContrast(timeline);
if (worst.ratio < 4.5) {
  problems.push(
    `worst bare-sky contrast is ${worst.ratio.toFixed(2)} at hour ${worst.where.hour} ` +
      `(cell ${worst.where.cell}, surface ${worst.where.surface}) — below AA`,
  );
}

const fieldKb = timeline.reduce((sum, f) => sum + f.field.length, 0) / 1024;
if (fieldKb > FIELD_BUDGET_KB) {
  problems.push(
    `the field images are ${fieldKb.toFixed(1)}KB of module source, past the ${FIELD_BUDGET_KB}KB ` +
      "budget. Shrink the field in extract-starcode-sky-source.mjs and re-extract.",
  );
}

const summary =
  `${timeline.length} keyframes at ${fieldSize().width}x${fieldSize().height}, ` +
  `${fieldKb.toFixed(1)}KB of fields, ceiling ${LIGHTNESS_CEILING}, ` +
  `${clamped}/${total} cells at the contrast floor, ` +
  `worst bare-sky contrast ${worst.ratio.toFixed(2)}`;

if (process.argv.includes("--check")) {
  const onDisk = NodeFS.existsSync(outputPath) ? NodeFS.readFileSync(outputPath, "utf8") : "";
  if (onDisk !== generated) {
    problems.push(
      `${NodePath.relative(NodePath.resolve(here, ".."), outputPath)} is out of sync with the ` +
        "derivation. Re-run without --check.",
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log(`sky timeline in sync: ${summary}`);
  process.exit(0);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

NodeFS.writeFileSync(outputPath, generated);
console.error(`wrote ${NodePath.relative(NodePath.resolve(here, ".."), outputPath)}: ${summary}`);
