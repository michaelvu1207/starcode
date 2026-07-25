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

  it("emits values the stylesheet can consume", () => {
    for (const hour of [0, 3, 6.9, 12, 18, 21, 23.9]) {
      const sky = resolveSkyForHour(hour);
      for (const colour of [sky.top, sky.wash]) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      for (const field of [sky.fieldA, sky.fieldB]) {
        expect(field.startsWith("data:image/png;base64,")).toBe(true);
      }
      expect(sky.stars).toBeGreaterThanOrEqual(0);
      expect(sky.stars).toBeLessThanOrEqual(1);
      expect(sky.blend).toBeGreaterThanOrEqual(0);
      expect(sky.blend).toBeLessThanOrEqual(1);
    }
  });

  it("keeps midnight and the end of the day identical, so the wrap is seamless", () => {
    expect(resolveSkyForHour(0)).toEqual(resolveSkyForHour(24));
  });

  it("hands over the pair the clock sits between, in order", () => {
    // The fields are images and do not interpolate in CSS, so the crossfade is
    // two stacked layers and an opacity. A resolver that returned one field
    // would step the whole sky every half hour.
    const midway = resolveSkyForHour(20.25);
    expect(midway.fieldA).toBe(SKY_TIMELINE.find((f) => f.hour === 20)!.field);
    expect(midway.fieldB).toBe(SKY_TIMELINE.find((f) => f.hour === 20.5)!.field);
    expect(midway.blend).toBeCloseTo(0.5, 5);
  });

  it("lands exactly on a keyframe at its own hour", () => {
    const onIt = resolveSkyForHour(20);
    expect(onIt.blend).toBe(0);
    expect(onIt.fieldA).toBe(SKY_TIMELINE.find((f) => f.hour === 20)!.field);
  });

  it("is brighter at midday than at midnight, which is the whole feature", () => {
    // The first version solved one lightness ceiling for the entire day, so noon
    // and dusk rendered identically. This is the regression test for that.
    const luminance = (hex: string) =>
      [1, 3, 5]
        .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);

    const noon = luminance(resolveSkyForHour(13).top);
    const dusk = luminance(resolveSkyForHour(19).top);
    const midnight = luminance(resolveSkyForHour(2).top);
    expect(noon).toBeGreaterThan(midnight * 4);
    expect(noon).toBeGreaterThan(dusk * 1.3);
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

  it("carries a decodable field per keyframe", () => {
    for (const frame of SKY_TIMELINE) {
      expect(frame.field.startsWith("data:image/png;base64,")).toBe(true);
      // The PNG signature, so a truncated or mis-encoded field fails here rather
      // than as a blank backdrop nobody notices in a screenshot.
      const bytes = atob(frame.field.slice("data:image/png;base64,".length));
      const signature = Array.from({ length: 8 }, (_, i) => bytes.charCodeAt(i));
      expect(signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  it("closes the loop at midnight", () => {
    const first = SKY_TIMELINE[0]!;
    const last = SKY_TIMELINE[SKY_TIMELINE.length - 1]!;
    expect(last.field).toBe(first.field);
    expect(last.stars).toBe(first.stars);
    expect(last.wash).toBe(first.wash);
  });
});
