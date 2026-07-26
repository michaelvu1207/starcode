import { describe, expect, it } from "vite-plus/test";

import { connectionAccentHue } from "./ConnectionMark.model";

describe("connectionAccentHue", () => {
  it("gives the same machine the same hue every time it is asked", () => {
    expect(connectionAccentHue("env-laptop")).toBe(connectionAccentHue("env-laptop"));
  });

  it("stays inside the colour wheel", () => {
    for (const id of ["", "a", "env-local", "env-simforge1", "🛰", "env-".repeat(40)]) {
      const hue = connectionAccentHue(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("spreads ids that share a prefix, which is what real environment ids do", () => {
    // The fleet's ids are `env-<machine>`: a hash whose low bits leak the
    // prefix would put every machine in the same corner of the wheel. Nothing
    // guarantees a minimum separation, but landing four of them inside 20° of
    // each other would mean the mixing round stopped working.
    const hues = ["env-laptop", "env-pathpc", "env-simforge1", "env-local"].map(
      connectionAccentHue,
    );
    const spread = Math.max(...hues) - Math.min(...hues);
    expect(new Set(hues).size).toBe(4);
    expect(spread).toBeGreaterThan(20);
  });

  it("keys on the id and never on the label, so a rename does not repaint", () => {
    // The guarantee callers depend on: the only input is the id. Two machines
    // a user happens to have named the same thing are still two colours.
    expect(connectionAccentHue("env-a")).not.toBe(connectionAccentHue("env-b"));
  });
});
