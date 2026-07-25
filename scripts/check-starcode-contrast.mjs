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
  RAW_SKY_TEXT,
  STAR_CHROME_MAX,
  STAR_TINT,
  buildTimeline,
  decodeField,
  rgbToHex,
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
// The sky, swept per cell.
//
// The backdrop is no longer four hand-picked phases, and no longer even a stop
// list. It is a 38-keyframe timeline of 20x12 colour fields derived from a
// day-to-night time-lapse, so the surface a text token can land on is one of
// 9120 rather than one of eight. Transcribing that here stopped being an option
// two revisions ago.
//
// The timeline is therefore IMPORTED rather than transcribed. That is a real
// change in this file's guarantee: the checks above are still copies of values
// that live in the CSS and can silently desync, but the sky cannot drift from
// what it is being checked against, because both come from the same derivation.
// `derive-starcode-sky-timeline.mjs --check` holds the shipped module to the
// same source.
//
// THE AUDIT THAT SETS THE FLOORS, and which the previous revision got wrong by
// being too cautious. Text lands on the sky in exactly two ways:
//
//   bare    the pairing screen, which has no panel — its wordmark and copy sit
//           on the sky itself. The only token there is `--foreground`, a cream.
//           This is the floor the derivation's own clamp enforces.
//   panel   everywhere else. The sidebar and the pane are tinted glass at
//           `--sc-glass-panel`, and dialogs and popovers add a second layer at
//           the user's minimum `glassOpacity`. EVERY token can land here,
//           including `--muted-foreground`, which is the tightest in the set.
//
// Holding the tightest body token against the bare sky — which it never
// touches — is what made the first field-less version's daylight two stops
// darker than it needed to be. Holding it against the panel composite, which it
// does touch, is both correct and what lets the sky carry real colour.
//
// The blur is not modelled and does not need to be: it only ever averages
// neighbouring cells, so no blurred pixel can be lighter than the lightest cell
// it came from. Checking every cell bounds every pixel.
const VERBOSE = process.argv.includes("--verbose");
const TIMELINE = buildTimeline();

// Transcribed from `--sc-glass-panel` in starcode-theme.css. Solved below.
const GLASS_PANEL = 0.38;
// `MIN_GLASS_OPACITY` from packages/contracts/src/settings.ts — the most
// transparent a user can drag the slider, and therefore the only value worth
// gating on. Checking the default would be checking the easy case.
const MIN_GLASS_OPACITY = 0.4;

/** Every cell of every keyframe, as a hex, with its keyframe's star level. */
const CELLS = TIMELINE.flatMap((frame) =>
  decodeField(frame.field).map((cell, index) => ({
    hour: frame.hour,
    index,
    stars: frame.stars,
    hex: rgbToHex(cell),
  })),
);

/** A cell, plus the brightest star the chrome field can put on it. */
function litCell(cell) {
  if (cell.stars <= 0) return cell.hex;
  return over(STAR_TINT, cell.stars * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, cell.hex);
}
const LIT = CELLS.map(litCell);

/**
 * Sweep a stack across every cell.
 *
 * Emits at most one row per (stack, token) unless `--verbose` — the worst one —
 * plus every failure. 9120 cells times 12 tokens times six stacks is 650k
 * comparisons; printing them is not a report, it is a haystack.
 */
function sweep(stack, surfaceFor, texts, floor = 4.5) {
  const worstPerToken = new Map();
  for (const [i, cell] of CELLS.entries()) {
    const surface = surfaceFor(LIT[i], cell);
    for (const [tName, tHex] of Object.entries(texts)) {
      const r = ratio(tHex, surface);
      const pass = r >= floor;
      if (!pass) fails++;
      const current = worstPerToken.get(tName);
      const row = [
        stack,
        tName,
        tHex,
        `${cell.hour}h cell${cell.index}`,
        surface,
        r.toFixed(2),
        pass ? "AA" : "FAIL",
      ];
      if (!current || r < current.r) worstPerToken.set(tName, { r, row });
      if (VERBOSE || !pass) rows.push(row);
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
// Bare sky: only the pairing screen's cream reaches it.
worst.bare = sweep("bare", (lit) => lit, { foreground: RAW_SKY_TEXT });
worst.pane = sweep("pane", (lit) => over(DARK.background, GLASS_PANEL, lit), paneText);
worst.sidebar = sweep("sidebar", (lit) => over(DARK.sidebar, GLASS_PANEL, lit), sidebarText);
worst.popover = sweep(
  "popover",
  (lit) => over(DARK.popover, MIN_GLASS_OPACITY, over(DARK.background, GLASS_PANEL, lit)),
  paneText,
);
worst.card = sweep(
  "card",
  (lit) => over(DARK.card, MIN_GLASS_OPACITY, over(DARK.background, GLASS_PANEL, lit)),
  paneText,
);

// ---------------------------------------------------------------------------
// Solve `--sc-glass-panel`, rather than trusting the number transcribed above.
//
// More opaque is always safer — at 100% the panel is the flat palette every
// check at the top of this file already passes — so there is a lowest alpha
// that still clears the floor everywhere, and bisecting for it turns "55%
// looked good" into "55% is inside the margin, and here is how much".
//
// This came back 0% while the sky was a dim gradient: every panel base was
// darker than every sky colour, so the tint could only raise contrast and the
// binding gate was one level up. The field is lighter and far more colourful,
// and its brightest cells now sit above the panel bases, so the number means
// something again. Same discipline as `--sc-star-chrome-max`.
function panelHolds(alpha) {
  for (const lit of LIT) {
    const pane = over(DARK.background, alpha, lit);
    const stacks = [
      [pane, paneText],
      [over(DARK.sidebar, alpha, lit), sidebarText],
      [over(DARK.popover, MIN_GLASS_OPACITY, pane), paneText],
      [over(DARK.card, MIN_GLASS_OPACITY, pane), paneText],
    ];
    for (const [surface, texts] of stacks) {
      for (const tHex of Object.values(texts)) if (ratio(tHex, surface) < 4.5) return false;
    }
  }
  return true;
}

let panelLow = 0;
let panelHigh = 1;
for (let i = 0; i < 16; i += 1) {
  const mid = (panelLow + panelHigh) / 2;
  if (panelHolds(mid)) panelHigh = mid;
  else panelLow = mid;
}
const panelFloor = panelHigh;
const panelOk = GLASS_PANEL >= panelFloor;
if (!panelOk) fails++;
rows.push([
  "solve",
  "--sc-glass-panel",
  `${(GLASS_PANEL * 100).toFixed(0)}%`,
  "minimum that holds AA",
  `${(panelFloor * 100).toFixed(1)}%`,
  "—",
  panelOk ? "OK" : "FAIL",
]);

// ---------------------------------------------------------------------------
// The light theme's wash.
//
// The light theme does not paint the field — a photograph of a night sky on
// linen is a smudge, which is the same reason the starfield has never been
// allowed on paper. It keeps the wash gradient, checked at its strongest stop
// (58% over `--background`) and again through the panel tint.
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
      const row = [
        "sky-lt",
        tName,
        tHex,
        `${frame.hour}h wash`,
        surface,
        r.toFixed(2),
        pass ? "AA" : "FAIL",
      ];
      const current = worstPerToken.get(tName);
      if (!current || r < current.r) worstPerToken.set(tName, { r, row });
      if (VERBOSE || !pass) rows.push(row);
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
  for (const [i, cell] of CELLS.entries()) {
    const panel = over(DARK.background, GLASS_PANEL, LIT[i]);
    const surface = over(darkText.foreground, BAND_DARK_MAX, panel);
    const stroke = over(darkText.foreground, alpha, surface);
    const r = ratio(stroke, surface);
    const pass = r >= 3;
    if (!pass) fails++;
    if (r < worstEdge.r) {
      worstEdge = {
        r,
        row: [
          "edge",
          `${kind} lineage edge`,
          stroke,
          `${cell.hour}h cell${cell.index}`,
          surface,
          r.toFixed(2),
          pass ? ">=3" : "FAIL(<3)",
        ],
      };
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
  `\nswept ${TIMELINE.length} keyframes x ${CELLS.length / TIMELINE.length} cells. ` +
    `Worst ratio per stack:\n` +
    Object.entries(worst)
      .map(([name, r]) => `  ${name.padEnd(8)} ${r.toFixed(2)}`)
      .join("\n") +
    `\n  --sc-glass-panel ${(GLASS_PANEL * 100).toFixed(0)}%, ` +
    `minimum that holds AA: ${(panelFloor * 100).toFixed(1)}%`,
);
console.log(
  VERBOSE ? "" : "\n(only the worst row per stack and token is shown; --verbose for all)",
);
console.log(`\n${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
