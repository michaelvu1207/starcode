import { describe, expect, it } from "vite-plus/test";

import { buildComposerContextRow } from "./composerContext.ts";

describe("buildComposerContextRow", () => {
  it("says nothing for a provider that makes no context claim", () => {
    expect(buildComposerContextRow({ hasSelector: false, fallbackTokens: null })).toBeNull();
  });

  it("leaves the row to the selector when the model offers one", () => {
    expect(buildComposerContextRow({ hasSelector: true, fallbackTokens: 600_000 })).toEqual({
      chipLabel: null,
      hint: "",
    });
  });

  it("keeps the selector row where the provider has no default to fall back on", () => {
    expect(buildComposerContextRow({ hasSelector: true, fallbackTokens: null })).toEqual({
      chipLabel: null,
      hint: "",
    });
  });

  it("states the instance default when the model exposes no choice", () => {
    const row = buildComposerContextRow({ hasSelector: false, fallbackTokens: 600_000 });
    expect(row?.chipLabel).toBe("600k");
    expect(row?.hint).toContain("Settings");
  });
});
