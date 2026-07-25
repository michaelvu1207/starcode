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
// Sky backdrop phases.
//
// `starcodeSky.ts` tints the TOP of the main pane per time of day, so the
// darkest surface a text token can land on is no longer `--background` — it is
// whichever phase colour is lightest. Transcript content sits below where the
// gradient has resolved, but headers, breadcrumbs, and empty-state copy sit in
// the tinted band, so every text token is re-checked against the extremes.
//
// Values transcribed from SKY_STOPS in `apps/web/src/starcodeSky.ts`.
const SKY_PHASES = {
  "night-top": "#0a0f24",
  "night-glow": "#0f173d",
  "dawn-top": "#49182d",
  "dawn-glow": "#481921",
  "day-top": "#1b304b",
  "day-glow": "#17314f",
  "dusk-top": "#3e183d",
  "dusk-glow": "#45172e",
};

for (const [tName, tHex] of Object.entries(darkText)) {
  if (tName.startsWith("sidebar-")) continue;
  for (const [sName, sHex] of Object.entries(SKY_PHASES)) {
    const r = ratio(tHex, sHex);
    const pass = r >= 4.5;
    if (!pass) fails++;
    rows.push(["sky", tName, tHex, sName, sHex, r.toFixed(2), pass ? "AA" : "FAIL"]);
  }
}

// The light theme's wash is a translucent tint over linen rather than an opaque
// fill, so the surface a token actually lands on is the composite. Checked at
// the strongest stop of each gradient — 55% on the main pane, 42% on the sidebar
// band — which is the darkest the paper ever gets.
const SKY_WASHES = {
  "night-wash": "#dde3f4",
  "dawn-wash": "#f9ddd4",
  "day-wash": "#d5e5f7",
  "dusk-wash": "#fae0be",
};

/** Composite `over` at `alpha` onto opaque `base`, both `#rrggbb`. */
function composite(over, base, alpha) {
  const [o, b] = [over, base].map((h) =>
    [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)),
  );
  const mixed = o.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

for (const [tName, tHex] of Object.entries(lightText)) {
  for (const [sName, sHex] of Object.entries(SKY_WASHES)) {
    const surface = tName.startsWith("sidebar-")
      ? composite(sHex, LIGHT.sidebar, 0.42)
      : composite(sHex, LIGHT.background, 0.72);
    const r = ratio(tHex, surface);
    const pass = r >= 4.5;
    if (!pass) fails++;
    rows.push(["sky-lt", tName, tHex, sName, surface, r.toFixed(2), pass ? "AA" : "FAIL"]);
  }
}

// ---------------------------------------------------------------------------
// The chrome starfield ceiling.
//
// Stars are painted across the sidebar and the main pane, which means one can
// land directly behind body text. `--sc-star-chrome-max` in starcode-theme.css
// is the layer opacity that makes that safe: at this value the brightest star in
// the tile composites to a colour that still clears AA against every text token.
//
// This block re-derives the guarantee rather than trusting it. If a phase colour
// is made lighter or the ceiling is raised past what the palette can carry, this
// fails and says so — which is the only reason it is safe to put a starfield
// behind working UI at all.
const STAR_CHROME_MAX = 0.26;
const STAR_TINT = "#eadcc6";
const BRIGHTEST_STAR_IN_TILE = 0.86;

const STAR_SURFACES = { background: DARK.background, sidebar: DARK.sidebar, ...SKY_PHASES };

// Phase scales the layer on top of the ceiling, so each phase is checked at the
// star count it actually renders with — night at full, dusk and dawn thinned,
// midday not at all. Checking every phase at the night value would fail colours
// that never carry a star.
const PHASE_STARS = {
  background: 1,
  sidebar: 1,
  "night-top": 1,
  "night-glow": 1,
  "dawn-top": 0.35,
  "dawn-glow": 0.35,
  "day-top": 0,
  "day-glow": 0,
  "dusk-top": 0.4,
  "dusk-glow": 0.4,
};

for (const [sName, sHex] of Object.entries(STAR_SURFACES)) {
  const phase = PHASE_STARS[sName] ?? 1;
  if (phase === 0) continue;
  const lit = over(STAR_TINT, phase * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, sHex);
  for (const [tName, tHex] of Object.entries(darkText)) {
    const r = ratio(tHex, lit);
    const pass = r >= 4.5;
    if (!pass) fails++;
    rows.push(["star", tName, tHex, `${sName}+star`, lit, r.toFixed(2), pass ? "AA" : "FAIL"]);
  }
}

// ---------------------------------------------------------------------------
// Workbench lineage edges.
//
// The star map draws one edge per "this feature grows out of that one". That is
// information, not decoration, so both the real and the planned edge answer to
// the 3:1 component floor — a plan whose branching cannot be traced is not
// conveying the plan, which is the whole reason the ghosts are drawn at all.
//
// The surface is not `--background`. An edge crosses the sky tint, the tier
// bands the map paints over it, and — being a long thin line rather than a
// glyph — is more likely than any text to run straight through a chrome star.
// All three are stacked here, so this is the worst pixel an edge can occupy
// rather than the average one.
//
// Values transcribed from BRANCH_STROKE and the band opacities in
// `apps/web/src/components/workbench/WorkbenchStarMap.tsx`.
const EDGE_ALPHA = { real: 0.7, planned: 0.6 };
// `--sc-band-dark` peaks at the top tier, `--sc-band-light` at the bottom one.
// Each is the value that pushes its theme's backdrop toward the stroke.
const BAND_DARK_MAX = 0.008 + 3 * 0.008;
const BAND_LIGHT_MAX = 0.03;

for (const [kind, alpha] of Object.entries(EDGE_ALPHA)) {
  for (const [sName, sHex] of Object.entries({ background: DARK.background, ...SKY_PHASES })) {
    const phase = PHASE_STARS[sName] ?? 1;
    const banded = over(darkText.foreground, BAND_DARK_MAX, sHex);
    const surface =
      phase === 0
        ? banded
        : over(STAR_TINT, phase * STAR_CHROME_MAX * BRIGHTEST_STAR_IN_TILE, banded);
    const stroke = over(darkText.foreground, alpha, surface);
    const r = ratio(stroke, surface);
    const pass = r >= 3;
    if (!pass) fails++;
    rows.push([
      "edge",
      `${kind} lineage edge`,
      stroke,
      `${sName}+band+star`,
      surface,
      r.toFixed(2),
      pass ? ">=3" : "FAIL(<3)",
    ]);
  }
  for (const [sName, sHex] of Object.entries({ paper: null, ...SKY_WASHES })) {
    const washed = sHex === null ? LIGHT.background : composite(sHex, LIGHT.background, 0.72);
    const surface = over(lightText.foreground, BAND_LIGHT_MAX, washed);
    const stroke = over(lightText.foreground, alpha, surface);
    const r = ratio(stroke, surface);
    const pass = r >= 3;
    if (!pass) fails++;
    rows.push([
      "edge-lt",
      `${kind} lineage edge`,
      stroke,
      `${sName}+band`,
      surface,
      r.toFixed(2),
      pass ? ">=3" : "FAIL(<3)",
    ]);
  }
}

// A ghost that reads as brightly as real work would make the plan look done.
// The floor is a floor, not a target: this holds the gap that keeps them
// distinguishable once both clear it.
if (!(EDGE_ALPHA.planned < EDGE_ALPHA.real)) {
  fails++;
  rows.push(["edge", "ghost stays subordinate", "—", "—", "—", "—", "FAIL"]);
}

// ---------------------------------------------------------------------------
// The glass floor.
//
// Dialogs, popovers and the composer paint at `--glass-opacity`, which the user
// can drag down to MIN_GLASS_OPACITY (40) in settings. At that setting the
// surface is mostly transparent, so its text is not sitting on `--popover` at
// all — it is sitting on 40% of that colour over whatever is behind, which on an
// idle route is the sky at its lightest.
//
// Every check above assumes an opaque surface, so none of them cover this. It is
// the one place a user setting can move a contrast ratio, which is exactly why
// it belongs in the gate rather than in a comment.
const MIN_GLASS_OPACITY = 0.4;
const GLASS_BEHIND = { ...SKY_PHASES, background: DARK.background };

for (const [surfaceName, surfaceHex] of [
  ["popover", DARK.popover],
  ["card", DARK.card],
]) {
  for (const [behindName, behindHex] of Object.entries(GLASS_BEHIND)) {
    const glass = over(surfaceHex, MIN_GLASS_OPACITY, behindHex);
    for (const [tName, tHex] of Object.entries(darkText)) {
      if (tName.startsWith("sidebar-")) continue;
      const r = ratio(tHex, glass);
      const pass = r >= 4.5;
      if (!pass) fails++;
      rows.push([
        "glass",
        tName,
        tHex,
        `${surfaceName}@40%/${behindName}`,
        glass,
        r.toFixed(2),
        pass ? "AA" : "FAIL",
      ]);
    }
  }
}

const w = [6, 34, 9, 26, 9, 7, 10];
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join(" ");
console.log(line(["theme", "token", "fg", "surface", "bg", "ratio", "verdict"]));
console.log("-".repeat(w.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) console.log(line(r));
console.log(`\n${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
