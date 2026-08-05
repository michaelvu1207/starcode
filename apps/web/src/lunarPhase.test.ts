import { describe, expect, it } from "vite-plus/test";

import { lunarPhaseAt } from "./lunarPhase";

describe("lunarPhaseAt", () => {
  it("calls the reference new moon new", () => {
    const phase = lunarPhaseAt(new Date(Date.UTC(2000, 0, 6, 18, 14)));
    expect(phase.name).toBe("new");
    expect(phase.illumination).toBeCloseTo(0, 3);
  });

  it("is full half a synodic month later", () => {
    const half = new Date(Date.UTC(2000, 0, 6, 18, 14) + 14.765 * 86_400_000);
    const phase = lunarPhaseAt(half);
    expect(phase.name).toBe("full");
    expect(phase.illumination).toBeGreaterThan(0.99);
  });

  it("waxes for the first half of the cycle and wanes for the second", () => {
    const base = Date.UTC(2000, 0, 6, 18, 14);
    expect(lunarPhaseAt(new Date(base + 7 * 86_400_000)).waxing).toBe(true);
    expect(lunarPhaseAt(new Date(base + 22 * 86_400_000)).waxing).toBe(false);
  });

  it("keeps illumination inside the unit range across a whole lunation", () => {
    const base = Date.UTC(2000, 0, 6, 18, 14);
    for (let hour = 0; hour < 30 * 24; hour += 3) {
      const { illumination, fraction } = lunarPhaseAt(new Date(base + hour * 3_600_000));
      expect(illumination).toBeGreaterThanOrEqual(0);
      expect(illumination).toBeLessThanOrEqual(1);
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThan(1);
    }
  });

  it("agrees with a known modern new moon", () => {
    // 2026-01-18 19:52 UTC, from a published ephemeris. The mean synodic month
    // drifts a few hours against the real one, so this asserts the phase reads
    // as new rather than asserting an exact instant.
    expect(lunarPhaseAt(new Date(Date.UTC(2026, 0, 18, 19, 52))).illumination).toBeLessThan(0.03);
  });

  it("agrees with a known modern full moon", () => {
    // 2026-01-03 10:03 UTC.
    expect(lunarPhaseAt(new Date(Date.UTC(2026, 0, 3, 10, 3))).illumination).toBeGreaterThan(0.97);
  });

  it("handles dates before the reference epoch", () => {
    const phase = lunarPhaseAt(new Date(Date.UTC(1969, 6, 20)));
    expect(phase.fraction).toBeGreaterThanOrEqual(0);
    expect(phase.fraction).toBeLessThan(1);
  });
});
