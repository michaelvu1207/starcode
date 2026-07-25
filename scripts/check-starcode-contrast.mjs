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
  background: "#12141f",
  card: "#171a27",
  popover: "#1d2130",
  sidebar: "#171a27",
  control: "#242938",
};
const LIGHT = {
  background: "#faf6ec",
  card: "#fffdf7",
  popover: "#fffdf7",
  sidebar: "#f5f0e2",
  control: "#efe8d6",
};

const darkText = {
  foreground: "#e9e3d6",
  "muted-foreground": "#a09a8c",
  "card-foreground": "#e9e3d6",
  "popover-foreground": "#e9e3d6",
  "sidebar-foreground": "#e9e3d6",
  "sidebar-muted-foreground": "#a09a8c",
  "accent-foreground": "#f4efe3",
  "secondary-foreground": "#e9e3d6",
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
  ["dark", "foreground on control surface", "#e9e3d6", DARK.control],
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
  ["dark", "border on background", over("#e9e3d6", 0.15, DARK.background), DARK.background, 1.3],
  ["dark", "ring on background", "#f0d9a0", DARK.background, 3],
  ["dark", "success dot on card", "#8fb488", DARK.card, 3],
  ["dark", "warning dot on card", "#dfae6b", DARK.card, 3],
  ["dark", "destructive dot on card", "#e08f88", DARK.card, 3],
  ["dark", "info dot on card", "#93b1de", DARK.card, 3],
  ["dark", "primary fill on background", "#f0d9a0", DARK.background, 3],
  [
    "dark",
    "input border on background",
    over("#e9e3d6", 0.3, DARK.background),
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

const w = [6, 34, 9, 12, 9, 7, 10];
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join(" ");
console.log(line(["theme", "token", "fg", "surface", "bg", "ratio", "verdict"]));
console.log("-".repeat(w.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) console.log(line(r));
console.log(`\n${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
