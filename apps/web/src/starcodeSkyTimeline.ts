/**
 * GENERATED — do not edit. Run:
 *
 *   node scripts/derive-starcode-sky-timeline.mjs
 *
 * The sky's colour script, measured off a day-to-night time-lapse and restyled
 * into this palette. https://www.youtube.com/watch?v=qJiopi3GbFw
 *
 * Each keyframe is one moment on the local clock: five gradient stops from
 * zenith to horizon, the light theme's wash, the star level, and the low glow
 * that gives the sky a direction. `starcodeSky.ts` interpolates between them
 * every minute; `starcode-theme.css` paints them.
 *
 * WHAT YOU CANNOT FIX BY EDITING THIS FILE. Nothing here was chosen — the
 * colours come from the footage, the compression that made them usable is in
 * `scripts/lib/starcode-sky-timeline.mjs`, and every taste knob is a named
 * constant at the top of that file. Change the knob and re-run. A colour edited
 * here survives exactly until the next person runs the generator, and
 * `--check` fails in the meantime.
 *
 * Sunrise 6.83, sunset 19, fixed rather than geolocated.
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
  {
    hour: 0,
    name: "night",
    stops: ["#090e16", "#090e17", "#090f17", "#090f19", "#090f18"],
    wash: "#d3e6ff",
    stars: 1,
    ember: { color: "#475f87", alpha: 0.05, x: 58.2 },
  },
  {
    hour: 1,
    name: "night",
    stops: ["#090e16", "#090e16", "#090e17", "#090f18", "#090f17"],
    wash: "#d3e6ff",
    stars: 1,
    ember: { color: "#475f87", alpha: 0.05, x: 48.3 },
  },
  {
    hour: 2,
    name: "night",
    stops: ["#090e16", "#090e17", "#090f18", "#09101a", "#09101a"],
    wash: "#d5e5ff",
    stars: 1,
    ember: { color: "#4b6188", alpha: 0.05, x: 38.5 },
  },
  {
    hour: 3,
    name: "night",
    stops: ["#0a0e17", "#0a0f18", "#09101a", "#0a111e", "#0c111f"],
    wash: "#d8e4ff",
    stars: 1,
    ember: { color: "#635d83", alpha: 0.05, x: 29.6 },
  },
  {
    hour: 4,
    name: "night",
    stops: ["#090e16", "#090f17", "#09101a", "#0a1421", "#0c182b"],
    wash: "#d3e5ff",
    stars: 1,
    ember: { color: "#8a5f58", alpha: 0.051, x: 22 },
  },
  {
    hour: 4.5,
    name: "night",
    stops: ["#091019", "#09121d", "#081624", "#081d31", "#0c1d30"],
    wash: "#cfe7ff",
    stars: 1,
    ember: { color: "#7f534d", alpha: 0.05, x: 18.9 },
  },
  {
    hour: 5,
    name: "night",
    stops: ["#081724", "#071c2d", "#052238", "#05263d", "#0a1a29"],
    wash: "#cee8fe",
    stars: 0.787,
    ember: { color: "#4a6393", alpha: 0.05, x: 16.3 },
  },
  {
    hour: 5.5,
    name: "dawn",
    stops: ["#081f32", "#082439", "#08273e", "#0a2337", "#091725"],
    wash: "#cee8fe",
    stars: 0.148,
    ember: { color: "#35668f", alpha: 0.05, x: 14.3 },
  },
  {
    hour: 6,
    name: "dawn",
    stops: ["#112b41", "#142e45", "#1a3046", "#1c2e41", "#112132"],
    wash: "#cfe7ff",
    stars: 0.055,
    ember: { color: "#4e6a8a", alpha: 0.05, x: 12.9 },
  },
  {
    hour: 6.5,
    name: "dawn",
    stops: ["#1f3951", "#253c53", "#2b3e53", "#344153", "#333845"],
    wash: "#cfe7ff",
    stars: 0,
    ember: { color: "#cf7c62", alpha: 0.087, x: 12.1 },
  },
  {
    hour: 7,
    name: "dawn",
    stops: ["#2c3c4d", "#323f4f", "#36424e", "#434851", "#55443c"],
    wash: "#fadeca",
    stars: 0,
    ember: { color: "#d8925d", alpha: 0.299, x: 12 },
  },
  {
    hour: 7.5,
    name: "dawn",
    stops: ["#36404a", "#3c444e", "#3d464e", "#4c4743", "#584432"],
    wash: "#f8dfc8",
    stars: 0,
    ember: { color: "#d39655", alpha: 0.273, x: 12.6 },
  },
  {
    hour: 8,
    name: "dawn",
    stops: ["#3e464e", "#404952", "#404953", "#484848", "#554534"],
    wash: "#f6e0c7",
    stars: 0,
    ember: { color: "#d09852", alpha: 0.197, x: 13.8 },
  },
  {
    hour: 8.5,
    name: "day",
    stops: ["#3f4750", "#404953", "#404953", "#414951", "#50463a"],
    wash: "#f4e1c6",
    stars: 0,
    ember: { color: "#c99c57", alpha: 0.119, x: 15.6 },
  },
  {
    hour: 9,
    name: "day",
    stops: ["#3a424d", "#3e4550", "#3f464f", "#3d434a", "#424344"],
    wash: "#f2e2c6",
    stars: 0,
    ember: { color: "#c79d4d", alpha: 0.078, x: 18 },
  },
  {
    hour: 9.5,
    name: "day",
    stops: ["#3a424d", "#39414c", "#3a414a", "#3b4048", "#383d44"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79858", alpha: 0.055, x: 20.9 },
  },
  {
    hour: 10,
    name: "day",
    stops: ["#404751", "#3a424e", "#383f4a", "#3c4149", "#393e45"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79657", alpha: 0.051, x: 24.4 },
  },
  {
    hour: 11,
    name: "day",
    stops: ["#414852", "#3a424e", "#383f4a", "#3c424a", "#393e45"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79657", alpha: 0.05, x: 32.5 },
  },
  {
    hour: 12,
    name: "day",
    stops: ["#414852", "#3a424e", "#383f4a", "#3c424a", "#393e45"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79657", alpha: 0.05, x: 41.8 },
  },
  {
    hour: 13,
    name: "day",
    stops: ["#414852", "#3a424e", "#383f4a", "#3c424a", "#393e45"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79657", alpha: 0.05, x: 51.7 },
  },
  {
    hour: 14,
    name: "day",
    stops: ["#414852", "#3a424e", "#383f4a", "#3c424a", "#393e45"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79657", alpha: 0.05, x: 61.5 },
  },
  {
    hour: 15,
    name: "day",
    stops: ["#414852", "#3a424e", "#383f4a", "#3c424a", "#393e45"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79657", alpha: 0.05, x: 70.4 },
  },
  {
    hour: 16,
    name: "day",
    stops: ["#3e4550", "#39414d", "#383f4a", "#3c4149", "#393d45"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#b79657", alpha: 0.051, x: 78 },
  },
  {
    hour: 17,
    name: "day",
    stops: ["#3c434e", "#404752", "#424853", "#3f454e", "#494743"],
    wash: "#f1e2c6",
    stars: 0,
    ember: { color: "#c59f4d", alpha: 0.089, x: 83.7 },
  },
  {
    hour: 17.5,
    name: "dusk",
    stops: ["#3f4650", "#414854", "#404855", "#434851", "#504735"],
    wash: "#f2e2c6",
    stars: 0,
    ember: { color: "#c79d4d", alpha: 0.139, x: 85.7 },
  },
  {
    hour: 18,
    name: "dusk",
    stops: ["#3b414b", "#414752", "#414854", "#4a4743", "#54462e"],
    wash: "#f2e2c6",
    stars: 0,
    ember: { color: "#c79d4d", alpha: 0.228, x: 87.1 },
  },
  {
    hour: 18.5,
    name: "dusk",
    stops: ["#333a4a", "#393f4d", "#3b414d", "#494746", "#57452d"],
    wash: "#f4e1c6",
    stars: 0,
    ember: { color: "#c99c4e", alpha: 0.287, x: 87.9 },
  },
  {
    hour: 19,
    name: "dusk",
    stops: ["#2a3751", "#313a53", "#353d52", "#414556", "#504440"],
    wash: "#f7dfc8",
    stars: 0,
    ember: { color: "#d19853", alpha: 0.278, x: 88 },
  },
  {
    hour: 19.5,
    name: "dusk",
    stops: ["#203050", "#243454", "#2a3653", "#303852", "#282d42"],
    wash: "#d6e5ff",
    stars: 0,
    ember: { color: "#a17eb1", alpha: 0.05, x: 87.4 },
  },
  {
    hour: 20,
    name: "dusk",
    stops: ["#12223d", "#152543", "#182845", "#19253e", "#101a2d"],
    wash: "#d5e5ff",
    stars: 0.255,
    ember: { color: "#4e638e", alpha: 0.05, x: 86.2 },
  },
  {
    hour: 20.5,
    name: "dusk",
    stops: ["#0a192e", "#0b1f39", "#0c2341", "#0d223d", "#0b1627"],
    wash: "#d3e6ff",
    stars: 0.455,
    ember: { color: "#40619a", alpha: 0.05, x: 84.4 },
  },
  {
    hour: 21,
    name: "night",
    stops: ["#09121f", "#091628", "#0a1c34", "#09203d", "#0d1a2e"],
    wash: "#d2e6ff",
    stars: 0.985,
    ember: { color: "#645a8c", alpha: 0.05, x: 82 },
  },
  {
    hour: 21.5,
    name: "night",
    stops: ["#090f17", "#091019", "#09121f", "#0b182b", "#0e1b31"],
    wash: "#d4e5ff",
    stars: 1,
    ember: { color: "#87563d", alpha: 0.05, x: 79.1 },
  },
  {
    hour: 22,
    name: "night",
    stops: ["#090e16", "#090e17", "#090f19", "#0b111f", "#0e1527"],
    wash: "#d7e4ff",
    stars: 1,
    ember: { color: "#695b83", alpha: 0.05, x: 75.6 },
  },
  {
    hour: 22.5,
    name: "night",
    stops: ["#090e17", "#090e17", "#0a0f19", "#0b101d", "#0d1120"],
    wash: "#dae3ff",
    stars: 1,
    ember: { color: "#685889", alpha: 0.05, x: 71.8 },
  },
  {
    hour: 23,
    name: "night",
    stops: ["#0a0e18", "#0a0f18", "#09101a", "#0a111e", "#0c111f"],
    wash: "#d8e4ff",
    stars: 0.994,
    ember: { color: "#5a5d8e", alpha: 0.05, x: 67.5 },
  },
  {
    hour: 23.5,
    name: "night",
    stops: ["#090e17", "#090f18", "#090f19", "#09101c", "#0a101c"],
    wash: "#d5e5ff",
    stars: 1,
    ember: { color: "#4a6397", alpha: 0.05, x: 63 },
  },
  {
    hour: 24,
    name: "night",
    stops: ["#090e16", "#090e17", "#090f17", "#090f19", "#090f18"],
    wash: "#d3e6ff",
    stars: 1,
    ember: { color: "#475f87", alpha: 0.05, x: 58.2 },
  },
];
