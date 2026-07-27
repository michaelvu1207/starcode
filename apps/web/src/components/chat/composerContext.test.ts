import { describe, expect, it } from "vite-plus/test";

import { buildComposerContextRow } from "./composerContext.ts";

describe("buildComposerContextRow", () => {
  it("says nothing for a provider with neither a window nor a cap", () => {
    expect(
      buildComposerContextRow({ hasWindowSelector: false, windowValue: null, capTokens: null }),
    ).toBeNull();
  });

  it("names the cap when the cap is what binds", () => {
    expect(
      buildComposerContextRow({
        hasWindowSelector: true,
        windowValue: "1m",
        capTokens: 600_000,
      }),
    ).toEqual({ chipLabel: null, hint: "Compacts near 600k. Change in Settings." });
  });

  it("names the window when the window is below the cap", () => {
    expect(
      buildComposerContextRow({
        hasWindowSelector: true,
        windowValue: "200k",
        capTokens: 600_000,
      }),
    ).toEqual({ chipLabel: null, hint: "Compacts near 200k." });
  });

  it("falls back to a read-only chip when the model exposes no choice", () => {
    expect(
      buildComposerContextRow({
        hasWindowSelector: false,
        windowValue: null,
        capTokens: 600_000,
      }),
    ).toEqual({ chipLabel: "600k", hint: "Compacts near 600k. Change in Settings." });
  });

  it("makes no compaction claim for a driver without a cap", () => {
    expect(
      buildComposerContextRow({ hasWindowSelector: true, windowValue: "1m", capTokens: null }),
    ).toEqual({ chipLabel: null, hint: "" });
  });
});
