import { describe, expect, it } from "vite-plus/test";

import { resolveSkyForHour } from "./starcodeSky";
import { SKY_TIMELINE } from "./starcodeSkyTimeline";

describe("resolveSkyForHour", () => {
  it("names the phase the hour actually falls in", () => {
    expect(resolveSkyForHour(1).name).toBe("night");
    expect(resolveSkyForHour(7).name).toBe("dawn");
    expect(resolveSkyForHour(13).name).toBe("day");
    expect(resolveSkyForHour(19).name).toBe("dusk");
    expect(resolveSkyForHour(23).name).toBe("night");
  });

  it("shows stars at night and none at midday", () => {
    expect(resolveSkyForHour(2).stars).toBe(1);
    expect(resolveSkyForHour(13).stars).toBe(0);
  });

  it("transitions rather than steps", () => {
    // Partway through the pre-dawn ramp the star field is neither full nor gone,
    // which is the whole point — a hard cut at a keyframe would read as the app
    // repainting itself.
    const risingDawn = resolveSkyForHour(5.25);
    expect(risingDawn.stars).toBeGreaterThan(0.3);
    expect(risingDawn.stars).toBeLessThan(1);
    expect(risingDawn.top).not.toBe(resolveSkyForHour(5).top);
    expect(risingDawn.top).not.toBe(resolveSkyForHour(5.5).top);
  });

  it("moves monotonically from night into day", () => {
    const hours = [4, 5, 6, 7, 8, 9, 10];
    const stars = hours.map((hour) => resolveSkyForHour(hour).stars);
    for (let index = 1; index < stars.length; index += 1) {
      expect(stars[index]!).toBeLessThanOrEqual(stars[index - 1]!);
    }
  });

  it("wraps hours outside the day rather than clamping to an edge", () => {
    expect(resolveSkyForHour(25)).toEqual(resolveSkyForHour(1));
    expect(resolveSkyForHour(-1)).toEqual(resolveSkyForHour(23));
  });

  it("emits colours the stylesheet can consume", () => {
    for (const hour of [0, 3, 6.9, 12, 18, 21, 23.9]) {
      const sky = resolveSkyForHour(hour);
      for (const colour of [sky.top, sky.high, sky.glow, sky.low, sky.horizon, sky.wash]) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(sky.ember.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(sky.stars).toBeGreaterThanOrEqual(0);
      expect(sky.stars).toBeLessThanOrEqual(1);
      expect(sky.ember.alpha).toBeGreaterThan(0);
      expect(sky.ember.x).toBeGreaterThanOrEqual(0);
      expect(sky.ember.x).toBeLessThanOrEqual(100);
    }
  });

  it("keeps midnight and the end of the day identical, so the wrap is seamless", () => {
    expect(resolveSkyForHour(0)).toEqual(resolveSkyForHour(24));
  });

  it("puts the low glow east before noon and west after it", () => {
    // The one asymmetry that makes dawn and dusk tell themselves apart at a
    // glance. Derived from a fixed solar sweep, not from the source footage —
    // see the derivation script's header for why the footage's own azimuth is
    // discarded.
    expect(resolveSkyForHour(7).ember.x).toBeLessThan(50);
    expect(resolveSkyForHour(19).ember.x).toBeGreaterThan(50);
  });

  it("brightens the low glow around sunrise and sunset and nowhere else", () => {
    const noon = resolveSkyForHour(13).ember.alpha;
    const deepNight = resolveSkyForHour(2).ember.alpha;
    expect(resolveSkyForHour(7).ember.alpha).toBeGreaterThan(noon * 2);
    expect(resolveSkyForHour(18.5).ember.alpha).toBeGreaterThan(noon * 2);
    expect(noon).toBeLessThan(0.1);
    expect(deepNight).toBeLessThan(0.1);
  });
});

describe("SKY_TIMELINE", () => {
  it("is ascending and spans a whole day", () => {
    expect(SKY_TIMELINE[0]!.hour).toBe(0);
    expect(SKY_TIMELINE[SKY_TIMELINE.length - 1]!.hour).toBe(24);
    for (let index = 1; index < SKY_TIMELINE.length; index += 1) {
      expect(SKY_TIMELINE[index]!.hour).toBeGreaterThan(SKY_TIMELINE[index - 1]!.hour);
    }
  });

  it("carries five stops per keyframe", () => {
    for (const frame of SKY_TIMELINE) expect(frame.stops).toHaveLength(5);
  });

  it("closes the loop at midnight", () => {
    const first = SKY_TIMELINE[0]!;
    const last = SKY_TIMELINE[SKY_TIMELINE.length - 1]!;
    expect(last.stops).toEqual(first.stops);
    expect(last.stars).toBe(first.stars);
    expect(last.wash).toBe(first.wash);
  });
});
