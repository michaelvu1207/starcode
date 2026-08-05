import { describe, expect, it } from "@effect/vitest";

import {
  assertPiContextSupported,
  canonicalizePiProviderOptions,
  piContextChoicesForModel,
  piDefaultContextForModel,
  piContextTokens,
  readPiContext,
} from "./PiProviderOptions.ts";

describe("Pi provider options", () => {
  const model = (provider: string, id: string, contextWindow: number) => ({
    provider,
    id,
    contextWindow,
  });

  it("canonicalizes the Codex-shaped reasoningEffort alias", () => {
    expect(canonicalizePiProviderOptions([{ id: "reasoningEffort", value: "high" }])).toEqual([
      { id: "effort", value: "high" },
    ]);
    expect(
      canonicalizePiProviderOptions([
        { id: "effort", value: "high" },
        { id: "reasoningEffort", value: "high" },
      ]),
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  it("canonicalizes the editable Pi context choice alongside effort", () => {
    const options = canonicalizePiProviderOptions([
      { id: "context", value: "1m" },
      { id: "reasoningEffort", value: "high" },
    ]);
    expect(options).toEqual([
      { id: "effort", value: "high" },
      { id: "context", value: "1m" },
    ]);
    expect(readPiContext(options)).toBe("1m");
    expect(piContextTokens("200k")).toBe(200_000);
    expect(piContextTokens("600k")).toBe(600_000);
    expect(piContextTokens("1m")).toBe(1_000_000);
  });

  it("rejects conflicting aliases, unknown ids, non-string values, and invalid efforts", () => {
    expect(() =>
      canonicalizePiProviderOptions([
        { id: "effort", value: "low" },
        { id: "reasoningEffort", value: "high" },
      ]),
    ).toThrow("Conflicting Pi effort values 'low' and 'high'");
    expect(() => canonicalizePiProviderOptions([{ id: "context", value: "2m" }])).toThrow(
      "Invalid Pi context '2m'",
    );
    expect(() => canonicalizePiProviderOptions([{ id: "effort", value: true }])).toThrow(
      "Invalid Pi effort 'true'",
    );
    expect(() => canonicalizePiProviderOptions([{ id: "effort", value: "max" }])).toThrow(
      "Supported values: off, minimal, low, medium, high, xhigh",
    );
  });

  it.each([
    ["anthropic", "claude-opus-5"],
    ["anthropic", "claude-fable-5"],
  ])("offers the full contract for native million-token model %s/%s", (provider, id) => {
    const selected = model(provider, id, 1_000_000);
    expect(piContextChoicesForModel(selected)).toEqual(["200k", "600k", "1m"]);
    expect(piDefaultContextForModel(selected)).toBe("600k");
    expect(() => assertPiContextSupported(selected, "600k")).not.toThrow();
    expect(() => assertPiContextSupported(selected, "1m")).not.toThrow();
  });

  it("offers explicit larger Pi windows for GPT-5.6 Sol despite its recommended 272k record", () => {
    const selected = model("openai-codex", "gpt-5.6-sol", 272_000);
    expect(piContextChoicesForModel(selected)).toEqual(["200k", "600k", "1m"]);
    expect(piDefaultContextForModel(selected)).toBe("600k");
    expect(() => assertPiContextSupported(selected, "600k")).not.toThrow();
    expect(() => assertPiContextSupported(selected, "1m")).not.toThrow();
  });

  it.each([
    ["openai-codex", "gpt-5.6-sol"],
    ["anthropic", "claude-opus-5"],
    ["anthropic", "claude-fable-5"],
  ])(
    "keeps the full explicit preset contract for custom same-slug metadata %s/%s",
    (provider, id) => {
      const selected = model(provider, id, 222_000);
      expect(piContextChoicesForModel(selected)).toEqual(["200k", "600k", "1m"]);
      expect(piDefaultContextForModel(selected)).toBe("600k");
    },
  );

  it("offers the same account-blind presets for other Pi models", () => {
    const small = model("custom", "ordinary-128k", 128_000);
    expect(piContextChoicesForModel(small)).toEqual(["200k", "600k", "1m"]);
    expect(piDefaultContextForModel(small)).toBe("600k");
    expect(() => assertPiContextSupported(small, "600k")).not.toThrow();

    const million = model("custom", "million", 1_000_000);
    expect(piContextChoicesForModel(million)).toEqual(["200k", "600k", "1m"]);
    expect(piDefaultContextForModel(million)).toBe("600k");
  });
});
