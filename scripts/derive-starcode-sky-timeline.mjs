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
 * calls that, formats a TypeScript module, and holds the result to four
 * invariants: the deepest night lands on the kit's black, midnight wraps without
 * a step, the contrast clamp is bounding the sky rather than composing it, and
 * every stop clears AA.
 *
 * `--check` is the same shape as `derive-starcode-star-layers.mjs --check`, and
 * for the same reason: the shipped table has to stay a *derivation* of the
 * source rather than a snapshot of one. Hand-editing a colour in the generated
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
  contrastRatio,
  phaseForHour,
  clampReport,
  worstSkyContrast,
} from "./lib/starcode-sky-timeline.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const outputPath = NodePath.resolve(here, "..", "apps", "web", "src", "starcodeSkyTimeline.ts");

/** The kit's ground. The deepest keyframe has to land on it; see the assertion
    below, which is the machine-checked half of that rule. */
const INK_GROUND = "#0e1117";
/** How far the darkest sky may sit from the ground, as a contrast ratio. 1.08
    is imperceptible as a colour difference and generous enough to allow the
    zenith its cool cast. */
const NIGHT_GROUND_TOLERANCE = 1.08;

function formatModule(timeline) {
  const meta = SOURCE_META();
  // Emitted in the exact shape the repo's formatter produces. A one-line-per-
  // keyframe form is nicer to read here and gets rewrapped by `vp fmt`, which
  // then makes `--check` fail on a file nobody edited.
  const rows = timeline
    .map((frame) => {
      const stops = frame.stops.map((hex) => `"${hex}"`).join(", ");
      return [
        "  {",
        `    hour: ${frame.hour},`,
        `    name: "${phaseForHour(frame.hour)}",`,
        `    stops: [${stops}],`,
        `    wash: "${frame.wash}",`,
        `    stars: ${frame.stars},`,
        `    ember: { color: "${frame.ember.color}", alpha: ${frame.ember.alpha}, x: ${frame.ember.x} },`,
        "  },",
      ].join("\n");
    })
    .join("\n");

  return `/**
 * GENERATED — do not edit. Run:
 *
 *   node scripts/derive-starcode-sky-timeline.mjs
 *
 * The sky's colour script, measured off a day-to-night time-lapse and restyled
 * into this palette. ${meta.source}
 *
 * Each keyframe is one moment on the local clock: five gradient stops from
 * zenith to horizon, the light theme's wash, the star level, and the low glow
 * that gives the sky a direction. \`starcodeSky.ts\` interpolates between them
 * every minute; \`starcode-theme.css\` paints them.
 *
 * WHAT YOU CANNOT FIX BY EDITING THIS FILE. Nothing here was chosen — the
 * colours come from the footage, the compression that made them usable is in
 * \`scripts/lib/starcode-sky-timeline.mjs\`, and every taste knob is a named
 * constant at the top of that file. Change the knob and re-run. A colour edited
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
  /** Zenith to horizon: top, high, glow, low, horizon. */
  readonly stops: readonly [string, string, string, string, string];
  /** The light theme's tint for this hour. */
  readonly wash: string;
  /** Star field opacity, 0 to 1. */
  readonly stars: number;
  /** The one directional light: a warm low glow at sunrise and sunset. */
  readonly ember: { readonly color: string; readonly alpha: number; readonly x: number };
}

export type SkyPhaseName = "night" | "dawn" | "day" | "dusk";

export const SKY_TIMELINE: readonly SkyKeyframe[] = [
${rows}
];
`;
}

const timeline = buildTimeline(LIGHTNESS_CEILING);
const generated = formatModule(timeline);

if (process.argv.includes("--print")) {
  for (const frame of timeline) {
    console.log(
      String(frame.hour).padStart(5),
      phaseForHour(frame.hour).padEnd(5),
      frame.stops.join(" "),
      "wash",
      frame.wash,
      "stars",
      String(frame.stars).padEnd(5),
      "glow",
      frame.ember.color,
      String(frame.ember.alpha).padEnd(5),
      `${frame.ember.x}%`,
    );
  }
  process.exit(0);
}

/* The two invariants worth failing on, checked in both modes. */
const problems = [];

const darkest = timeline.reduce((a, b) => (a.stars >= b.stars && a.stops[0] <= b.stops[0] ? a : b));
const groundDelta = contrastRatio(darkest.stops[0], INK_GROUND);
if (groundDelta > NIGHT_GROUND_TOLERANCE) {
  problems.push(
    `the deepest night (${darkest.stops[0]} at ${darkest.hour}h) sits ${groundDelta.toFixed(3)}:1 ` +
      `off ${INK_GROUND}, past the ${NIGHT_GROUND_TOLERANCE} tolerance. The palette is anchored ` +
      `on that black; the sky does not get to drift off it.`,
  );
}

if (timeline[0].stops.join() !== timeline[timeline.length - 1].stops.join()) {
  problems.push("hour 0 and hour 24 differ, so the sky steps at midnight");
}

const { clamped, total } = clampReport();
if (clamped / total > 0.35) {
  problems.push(
    `${clamped} of ${total} gradient stops are pinned to the contrast floor. Past about a ` +
      "third, the clamp is composing the sky rather than bounding it, and the starlit hours " +
      "all flatten onto one lightness. Lower LIGHTNESS_CEILING or raise LIGHTNESS_GAMMA.",
  );
}

const worst = worstSkyContrast(timeline);
if (worst.ratio < 4.5) {
  problems.push(
    `worst text contrast is ${worst.ratio.toFixed(2)} at hour ${worst.where.hour} ` +
      `(stop ${worst.where.stop}, surface ${worst.where.surface}) — below AA`,
  );
}

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
  console.log(
    `sky timeline in sync: ${timeline.length} keyframes, ceiling ${LIGHTNESS_CEILING}, ` +
      `${clamped}/${total} stops at the contrast floor, worst text contrast ${worst.ratio.toFixed(2)}`,
  );
  process.exit(0);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

NodeFS.writeFileSync(outputPath, generated);
console.error(
  `wrote ${timeline.length} keyframes to ${NodePath.relative(NodePath.resolve(here, ".."), outputPath)} ` +
    `(ceiling ${LIGHTNESS_CEILING}, ${clamped}/${total} stops clamped, ` +
    `worst text contrast ${worst.ratio.toFixed(2)})`,
);
