/**
 * WCAG contrast gate for the starcode token set (`apps/web/src/starcode-theme.css`).
 *
 * The values below are transcribed from that file, not read out of it — there
 * is no CSS parser here, so a token changed in one place and not the other will
 * silently pass. Re-run after touching the palette:
 *
 *   node scripts/check-starcode-contrast.mjs
 *
 * Text tokens are held to AA (4.5:1) against every surface they can land on.
 * Indicator fills are held to the 3:1 UI-component minimum. Hairline borders
 * carry an informational floor only — they are separators, not affordances,
 * and upstream ships them fainter still.
 *
 * Exits non-zero on any failure.
 */
import {
  BRIGHTEST_STAR_IN_TILE,
  STAR_CHROME_MAX,
  STAR_TINT,
  buildTimeline,
} from "./lib/starcode-sky-timeline.mjs";

const hex = (h) => {
  const s = h.replace("#", "");
  const n =
    s.length === 3
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
};
const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lum = (h) => {
  const [r, g, b] = hex(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

// Composite an rgba-over-solid so alpha borders/tints can be checked as real colors.
const over = (fg, alpha, bg) => {
  const f = hex(fg),
    b = hex(bg);
  const mix = f.map((v, i) => v * alpha + b[i] * (1 - alpha));
  return (
    "#" +
    mix
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
};

const DARK = {
  background: "#0e1117",
  card: "#151a24",
  popover: "#1b2130",
  sidebar: "#151a24",
  control: "#232a3a",
};
const LIGHT = {
  background: "#faf6ec",
  card: "#fffdf7",
  popover: "#fffdf7",
  sidebar: "#f5f0e2",
  control: "#efe8d6",
};

const darkText = {
  foreground: "#eadcc6",
  "muted-foreground": "#c7b8a1",
  "card-foreground": "#eadcc6",
  "popover-foreground": "#eadcc6",
  "sidebar-foreground": "#eadcc6",
  "sidebar-muted-foreground": "#c7b8a1",
  "accent-foreground": "#f6f7f9",
  "secondary-foreground": "#eadcc6",
  "destructive-foreground": "#eda9a2",
  "success-foreground": "#a3c79a",
  "warning-foreground": "#e5bb79",
  "info-foreground": "#a8c2e6",
};
const lightText = {
  foreground: "#22252f",
  "muted-foreground": "#6a675d",
  "card-foreground": "#22252f",
  "popover-foreground": "#22252f",
  "sidebar-foreground": "#22252f",
  "sidebar-muted-foreground": "#6a675d",
  "accent-foreground": "#161821",
  "secondary-foreground": "#22252f",
  "destructive-foreground": "#a13c36",
  "success-foreground": "#41653c",
  "warning-foreground": "#7d5a17",
  "info-foreground": "#3a5c8c",
};

// Pairs where the fg lands on a specific surface rather than every surface.
const PAIRS_EXTRA = [
  ["dark", "primary-foreground on primary", "#181b26", "#f0d9a0"],
  ["light", "primary-foreground on primary", "#f8f4e9", "#282c3c"],
  ["dark", "foreground on control surface", "#eadcc6", DARK.control],
  ["light", "foreground on control surface", "#22252f", LIGHT.control],
];

let fails = 0;
const rows = [];
for (const [themeName, surfaces, texts] of [
  ["dark", DARK, darkText],
  ["light", LIGHT, lightText],
]) {
  for (const [tName, tHex] of Object.entries(texts)) {
    for (const [sName, sHex] of Object.entries(surfaces)) {
      // sidebar-* tokens only ever paint on the sidebar surface.
      if (tName.startsWith("sidebar-") && sName !== "sidebar") continue;
      if (!tName.startsWith("sidebar-") && sName === "sidebar") continue;
      const r = ratio(tHex, sHex);
      const pass = r >= 4.5;
      if (!pass) fails++;
      rows.push([themeName, tName, tHex, sName, sHex, r.toFixed(2), pass ? "AA" : "FAIL"]);
    }
  }
}
for (const [themeName, label, fg, bg] of PAIRS_EXTRA) {
  const r = ratio(fg, bg);
  const pass = r >= 4.5;
  if (!pass) fails++;
  rows.push([themeName, label, fg, "—", bg, r.toFixed(2), pass ? "AA" : "FAIL"]);
}

// Non-text tokens: 3:1 UI-component minimum (WCAG 1.4.11).
const UI = [
  ["dark", "border on background", over("#eadcc6", 0.15, DARK.background), DARK.background, 1.3],
  ["dark", "ring on background", "#f0d9a0", DARK.background, 3],
  ["dark", "success dot on card", "#8fb488", DARK.card, 3],
  ["dark", "warning dot on card", "#dfae6b", DARK.card, 3],
  ["dark", "destructive dot on card", "#e08f88", DARK.card, 3],
  ["dark", "info dot on card", "#93b1de", DARK.card, 3],
  ["dark", "primary fill on background", "#f0d9a0", DARK.background, 3],
  [
    "dark",
    "input border on background",
    over("#eadcc6", 0.3, DARK.background),
    DARK.background,
    1.3,
  ],
  ["light", "ring on background", "#a5822c", LIGHT.background, 3],
  ["light", "success dot on card", "#5c8354", LIGHT.card, 3],
  ["light", "warning dot on card", "#a97c22", LIGHT.card, 3],
  ["light", "destructive dot on card", "#b8524b", LIGHT.card, 3],
  ["light", "info dot on card", "#4c72a8", LIGHT.card, 3],
  ["light", "primary fill on background", "#282c3c", LIGHT.background, 3],
];
for (const [themeName, label, fg, bg, min] of UI) {
  const r = ratio(fg, bg);
  const pass = r >= min;
  if (!pass && min >= 3) fails++;
  rows.push([themeName, label, fg, "—", bg, r.toFixed(2), pass ? `>=${min}` : `FAIL(<${min})`]);
}

// ---------------------------------------------------------------------------
// The sky, swept.
//
// The backdrop is no longer four hand-picked phases. It is a 38-keyframe
// timeline derived from a day-to-night time-lapse, and every keyframe carries
// five gradient stops rather than two colours — so the surface a text token can
// land on is one of 190 rather than one of eight, and transcribing them here
// stopped being an option.
//
// The timeline is therefore IMPORTED rather than transcribed. That is a real
// change in this file's guarantee: the checks above are still copies of values
// that live in the CSS and can silently desync, but the sky can no longer drift
// from what it is being checked against, because both come from the same
// derivation. `derive-starcode-sky-timeline.mjs --check` holds the shipped
// module to the same source.
//
// Four stacks are swept, each a strictly worse surface than the last:
//
//   sky    text on the raw gradient stop
//   star   ...with the brightest chrome star composited on top of it
//   panel  ...seen through a structural panel at `--sc-glass-panel` (L1)
//   glass  ...and then through a popover or card at the user's minimum
//          `glassOpacity` of 40% (L2)
//
// The last one is the one that did not exist before this round: with opaque
// panels, a dialog at 40% sat on a known plate. Over the sky it sits on the sky,
// which is why `--sc-glass-panel` has to be solved rather than picked.
const VERBOSE = process.argv.includes("--verbose");
const TIMELINE = buildTimeline();

// Transcribed from `--sc-glass-panel` in starcode-theme.css. Solved below.
const GLASS_PANEL = 0.68;
// `MIN_GLASS_OPACITY` from packages/contracts/src/settings.ts — the most
// transparent a user can drag the slider, and therefore the only value worth
// gating on. Checking the default would be checking the easy case.
const MIN_GLASS_OPACITY = 0.4;

/** Sky stop, plus the brightest star the chrome field can put on it. */
function litSky(stop, stars) {
  if (stars <= 0) return stop;
  return over(STAR_TINT, stars * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, stop);
}

/**
 * Sweep a stack across the whole timeline and both panel bases.
 *
 * Emits at most one row per (stack, token) unless `--verbose` — the worst one —
 * plus every failure. 38 keyframes times 5 stops times 12 tokens times 4 stacks
 * is 91k comparisons; printing them is not a report, it is a haystack.
 */
function sweep(stack, surfaceFor, { floor = 4.5, texts = darkText } = {}) {
  const worstPerToken = new Map();
  for (const frame of TIMELINE) {
    for (const [index, stop] of frame.stops.entries()) {
      const surface = surfaceFor(stop, frame);
      for (const [tName, tHex] of Object.entries(texts)) {
        const r = ratio(tHex, surface);
        const pass = r >= floor;
        if (!pass) fails++;
        const key = tName;
        const current = worstPerToken.get(key);
        if (!current || r < current.r || (!pass && VERBOSE)) {
          worstPerToken.set(key, {
            r,
            row: [
              stack,
              tName,
              tHex,
              `${frame.hour}h stop${index}`,
              surface,
              r.toFixed(2),
              pass ? "AA" : "FAIL",
            ],
          });
        }
        if (VERBOSE || !pass) {
          rows.push([
            stack,
            tName,
            tHex,
            `${frame.hour}h stop${index}`,
            surface,
            r.toFixed(2),
            pass ? "AA" : "FAIL",
          ]);
        }
      }
    }
  }
  if (!VERBOSE) for (const { row } of worstPerToken.values()) rows.push(row);
  let worst = Infinity;
  for (const { r } of worstPerToken.values()) worst = Math.min(worst, r);
  return worst;
}

// Sidebar tokens only ever paint on the sidebar panel; everything else lands on
// the pane. Two bases, and each token is checked against the one it can reach.
const paneText = Object.fromEntries(
  Object.entries(darkText).filter(([name]) => !name.startsWith("sidebar-")),
);
const sidebarText = Object.fromEntries(
  Object.entries(darkText).filter(([name]) => name.startsWith("sidebar-")),
);

const worst = {};
worst.sky = sweep("sky", (stop) => stop, { texts: paneText });
worst.star = sweep("star", (stop, frame) => litSky(stop, frame.stars), { texts: paneText });
worst.pane = sweep(
  "pane",
  (stop, frame) => over(DARK.background, GLASS_PANEL, litSky(stop, frame.stars)),
  {
    texts: paneText,
  },
);
worst.sidebar = sweep(
  "sidebar",
  (stop, frame) => over(DARK.sidebar, GLASS_PANEL, litSky(stop, frame.stars)),
  { texts: sidebarText },
);
worst.glass = sweep(
  "glass",
  (stop, frame) =>
    over(
      DARK.popover,
      MIN_GLASS_OPACITY,
      over(DARK.background, GLASS_PANEL, litSky(stop, frame.stars)),
    ),
  { texts: paneText },
);
worst.card = sweep(
  "card",
  (stop, frame) =>
    over(
      DARK.card,
      MIN_GLASS_OPACITY,
      over(DARK.background, GLASS_PANEL, litSky(stop, frame.stars)),
    ),
  { texts: paneText },
);

// ---------------------------------------------------------------------------
// Solve `--sc-glass-panel`, rather than trusting the number transcribed above.
//
// More opaque is always safer — at 100% the panel is the flat palette every
// check above already passes — so there is a lowest alpha that still clears the
// floor everywhere, and bisecting for it turns "82% looked fine" into "82% is
// inside the margin, and here is how much margin". Same discipline as
// `--sc-star-chrome-max`.
//
// THE ANSWER, AS OF THIS TIMELINE, IS ZERO, and that is worth understanding
// rather than deleting. Every panel base (`--background`, `--sidebar`,
// `--popover`, `--card`) is darker than the sky at every hour it could matter,
// so tinting a panel over the sky can only *raise* contrast. The binding
// constraint is one level up: `LIGHTNESS_CEILING` in the timeline derivation is
// already solved so that text clears AA on the raw star-lit sky with no panel at
// all. Which means the panel tint is not a legibility knob — it is pure taste,
// and it can go as low as it looks good at. The bisection stays because that
// conclusion is a property of the current palette and timeline, not a law; if
// either gets lighter, this is where it will show up first.
function panelHolds(alpha) {
  for (const frame of TIMELINE) {
    for (const stop of frame.stops) {
      const lit = litSky(stop, frame.stars);
      const stacks = [
        [over(DARK.background, alpha, lit), paneText],
        [over(DARK.sidebar, alpha, lit), sidebarText],
        [over(DARK.popover, MIN_GLASS_OPACITY, over(DARK.background, alpha, lit)), paneText],
        [over(DARK.card, MIN_GLASS_OPACITY, over(DARK.background, alpha, lit)), paneText],
      ];
      for (const [surface, texts] of stacks) {
        for (const tHex of Object.values(texts)) if (ratio(tHex, surface) < 4.5) return false;
      }
    }
  }
  return true;
}

let panelLow = 0;
let panelHigh = 1;
for (let i = 0; i < 20; i += 1) {
  const mid = (panelLow + panelHigh) / 2;
  if (panelHolds(mid)) panelHigh = mid;
  else panelLow = mid;
}
const panelFloor = panelHigh;
if (GLASS_PANEL < panelFloor) {
  fails++;
  rows.push([
    "solve",
    "--sc-glass-panel",
    `${(GLASS_PANEL * 100).toFixed(0)}%`,
    "minimum that holds AA",
    `${(panelFloor * 100).toFixed(1)}%`,
    "—",
    "FAIL",
  ]);
} else {
  rows.push([
    "solve",
    "--sc-glass-panel",
    `${(GLASS_PANEL * 100).toFixed(0)}%`,
    "minimum that holds AA",
    `${(panelFloor * 100).toFixed(1)}%`,
    "—",
    "OK",
  ]);
}

// ---------------------------------------------------------------------------
// The light theme's wash.
//
// A translucent tint over linen rather than an opaque fill, so the surface a
// token actually lands on is the composite — checked at the strongest stop of
// the sky gradient (58% over `--background`), which is the darkest the paper
// ever gets, and again through the panel tint.
{
  const worstPerToken = new Map();
  for (const frame of TIMELINE) {
    const paper = over(frame.wash, 0.58, LIGHT.background);
    for (const [tName, tHex] of Object.entries(lightText)) {
      const base = tName.startsWith("sidebar-") ? LIGHT.sidebar : LIGHT.background;
      const surface = over(base, GLASS_PANEL, paper);
      const r = ratio(tHex, surface);
      const pass = r >= 4.5;
      if (!pass) fails++;
      const current = worstPerToken.get(tName);
      if (!current || r < current.r) {
        worstPerToken.set(tName, {
          r,
          row: [
            "sky-lt",
            tName,
            tHex,
            `${frame.hour}h wash`,
            surface,
            r.toFixed(2),
            pass ? "AA" : "FAIL",
          ],
        });
      }
      if (VERBOSE || !pass) {
        rows.push([
          "sky-lt",
          tName,
          tHex,
          `${frame.hour}h wash`,
          surface,
          r.toFixed(2),
          pass ? "AA" : "FAIL",
        ]);
      }
    }
  }
  if (!VERBOSE) for (const { row } of worstPerToken.values()) rows.push(row);
  worst.light = Math.min(...[...worstPerToken.values()].map((v) => v.r));
}

// ---------------------------------------------------------------------------
// Workbench lineage edges.
//
// The star map draws one edge per "this feature grows out of that one". That is
// information, not decoration, so both the real and the planned edge answer to
// the 3:1 component floor — a plan whose branching cannot be traced is not
// conveying the plan, which is the whole reason the ghosts are drawn at all.
//
// The surface is not `--background`. An edge crosses the sky, the tier bands the
// map paints over it, the panel tint, and — being a long thin line rather than a
// glyph — is more likely than any text to run straight through a chrome star.
// All of them are stacked here, so this is the worst pixel an edge can occupy
// rather than the average one.
//
// Values transcribed from BRANCH_STROKE and the band opacities in
// `apps/web/src/components/workbench/WorkbenchStarMap.tsx`.
const EDGE_ALPHA = { real: 0.7, planned: 0.6 };
// `--sc-band-dark` peaks at the top tier, `--sc-band-light` at the bottom one.
const BAND_DARK_MAX = 0.008 + 3 * 0.008;
const BAND_LIGHT_MAX = 0.03;

for (const [kind, alpha] of Object.entries(EDGE_ALPHA)) {
  let worstEdge = { r: Infinity, row: null };
  for (const frame of TIMELINE) {
    for (const [index, stop] of frame.stops.entries()) {
      const panel = over(DARK.background, GLASS_PANEL, litSky(stop, frame.stars));
      const surface = over(darkText.foreground, BAND_DARK_MAX, panel);
      const stroke = over(darkText.foreground, alpha, surface);
      const r = ratio(stroke, surface);
      const pass = r >= 3;
      if (!pass) fails++;
      if (r < worstEdge.r || (!pass && VERBOSE)) {
        worstEdge = {
          r,
          row: [
            "edge",
            `${kind} lineage edge`,
            stroke,
            `${frame.hour}h stop${index}`,
            surface,
            r.toFixed(2),
            pass ? ">=3" : "FAIL(<3)",
          ],
        };
      }
    }
  }
  rows.push(worstEdge.row);

  let worstLight = { r: Infinity, row: null };
  for (const frame of TIMELINE) {
    const washed = over(frame.wash, 0.58, LIGHT.background);
    const surface = over(lightText.foreground, BAND_LIGHT_MAX, washed);
    const stroke = over(lightText.foreground, alpha, surface);
    const r = ratio(stroke, surface);
    const pass = r >= 3;
    if (!pass) fails++;
    if (r < worstLight.r) {
      worstLight = {
        r,
        row: [
          "edge-lt",
          `${kind} lineage edge`,
          stroke,
          `${frame.hour}h wash`,
          surface,
          r.toFixed(2),
          pass ? ">=3" : "FAIL(<3)",
        ],
      };
    }
  }
  rows.push(worstLight.row);
}

// A ghost that reads as brightly as real work would make the plan look done.
if (!(EDGE_ALPHA.planned < EDGE_ALPHA.real)) {
  fails++;
  rows.push(["edge", "ghost stays subordinate", "—", "—", "—", "—", "FAIL"]);
}

const w = [8, 34, 9, 26, 9, 7, 10];
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join(" ");
console.log(line(["stack", "token", "fg", "surface", "bg", "ratio", "verdict"]));
console.log("-".repeat(w.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) console.log(line(r));

console.log(
  `\nswept ${TIMELINE.length} keyframes x 5 stops. Worst ratio per stack:\n` +
    Object.entries(worst)
      .map(([name, r]) => `  ${name.padEnd(8)} ${r.toFixed(2)}`)
      .join("\n") +
    `\n  --sc-glass-panel ${(GLASS_PANEL * 100).toFixed(0)}%, minimum that holds AA: ${(panelFloor * 100).toFixed(1)}%` +
    (panelFloor < 0.01
      ? " — unconstrained. Every panel base is darker than the sky, so the tint\n" +
        "    cannot lower contrast; the sky's own lightness ceiling is the binding gate.\n" +
        "    How much sky shows through the sidebar and the pane is a taste decision."
      : ""),
);
console.log(
  VERBOSE ? "" : "\n(only the worst row per stack and token is shown; --verbose for all)",
);
console.log(`\n${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
