import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerOptionsSummary,
  formatComposerEffortLabel,
  shortenComposerAccessLabel,
  shortenComposerModelName,
} from "./composerOptionsSummary.ts";

describe("buildComposerOptionsSummary", () => {
  it("renders the hidden bar state as one glanceable label", () => {
    const summary = buildComposerOptionsSummary({
      modelName: "Claude Fable 5",
      effort: "high",
      accessLabel: "Full access",
    });

    expect(summary.short).toBe("Fable 5 · High · Full");
    expect(summary.detail).toBe("Claude Fable 5 · High reasoning · Full access");
    expect(summary.parts).toEqual(["Fable 5", "High", "Full"]);
  });

  it("omits parts a provider does not expose", () => {
    const summary = buildComposerOptionsSummary({
      modelName: "GPT-5.5",
      effort: null,
      accessLabel: "Supervised",
    });

    expect(summary.short).toBe("GPT-5.5 · Supervised");
    expect(summary.detail).toBe("GPT-5.5 · Supervised");
  });

  it("falls back to a generic label when nothing is known", () => {
    const summary = buildComposerOptionsSummary({
      modelName: "  ",
      effort: undefined,
      accessLabel: "",
    });

    expect(summary.short).toBe("");
    expect(summary.detail).toBe("Model and session options");
  });
});

describe("shortenComposerModelName", () => {
  it("drops the vendor prefix but keeps standalone names", () => {
    expect(shortenComposerModelName("Claude Opus 5")).toBe("Opus 5");
    expect(shortenComposerModelName("Grok 4")).toBe("4");
    expect(shortenComposerModelName("GPT-5.5")).toBe("GPT-5.5");
    expect(shortenComposerModelName("Composer 1")).toBe("Composer 1");
    expect(shortenComposerModelName("Claude")).toBe("Claude");
  });
});

describe("formatComposerEffortLabel", () => {
  it("maps raw option values to their display labels", () => {
    expect(formatComposerEffortLabel("xhigh")).toBe("Extra high");
    expect(formatComposerEffortLabel("HIGH")).toBe("High");
    expect(formatComposerEffortLabel("bespoke")).toBe("bespoke");
    expect(formatComposerEffortLabel("  ")).toBe("");
  });
});

describe("shortenComposerAccessLabel", () => {
  it("keeps only the distinguishing first word", () => {
    expect(shortenComposerAccessLabel("Full access")).toBe("Full");
    expect(shortenComposerAccessLabel("Auto-accept edits")).toBe("Auto-accept");
    expect(shortenComposerAccessLabel("Supervised")).toBe("Supervised");
    expect(shortenComposerAccessLabel("")).toBe("");
  });
});
