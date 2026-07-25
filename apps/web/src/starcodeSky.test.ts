import { describe, expect, it } from "vite-plus/test";

import { resolveSkyForHour } from "./starcodeSky";

describe("resolveSkyForHour", () => {
  it("names the phase the hour actually falls in", () => {
    expect(resolveSkyForHour(1).name).toBe("night");
    expect(resolveSkyForHour(7.5).name).toBe("dawn");
    expect(resolveSkyForHour(13).name).toBe("day");
    expect(resolveSkyForHour(19).name).toBe("dusk");
    expect(resolveSkyForHour(23).name).toBe("night");
  });

  it("shows stars at night and none at midday", () => {
    expect(resolveSkyForHour(2).stars).toBe(1);
    expect(resolveSkyForHour(13).stars).toBe(0);
  });

  it("transitions rather than steps", () => {
    // Halfway through the dawn ramp the star field is neither full nor gone,
    // which is the whole point — a hard cut at a phase boundary would read as
    // the app repainting itself.
    const midDawn = resolveSkyForHour(6.25);
    expect(midDawn.stars).toBeGreaterThan(0.3);
    expect(midDawn.stars).toBeLessThan(1);
    expect(midDawn.top).not.toBe(resolveSkyForHour(5).top);
    expect(midDawn.top).not.toBe(resolveSkyForHour(7.5).top);
  });

  it("moves monotonically from night into day", () => {
    const hours = [5, 6, 7, 8, 9, 10];
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
    for (const hour of [0, 3, 7.5, 12, 18, 21, 23.9]) {
      const sky = resolveSkyForHour(hour);
      expect(sky.top).toMatch(/^#[0-9a-f]{6}$/);
      expect(sky.glow).toMatch(/^#[0-9a-f]{6}$/);
      expect(sky.stars).toBeGreaterThanOrEqual(0);
      expect(sky.stars).toBeLessThanOrEqual(1);
    }
  });

  it("keeps midnight and the end of the day identical, so the wrap is seamless", () => {
    expect(resolveSkyForHour(0)).toEqual(resolveSkyForHour(24));
  });
});
