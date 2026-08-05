import { assert, describe, it } from "@effect/vitest";

import { codexFastMultiplier, costOf, DEFAULT_CODEX_FAST_MULTIPLIER, rateFor } from "./pricing.ts";

const noTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
};

describe("rateFor", () => {
  it("matches a model id exactly", () => {
    const rate = rateFor("claude", "claude-opus-5");
    assert.isNotNull(rate);
    assert.strictEqual(rate?.input, 5 / 1_000_000);
    assert.strictEqual(rate?.output, 25 / 1_000_000);
  });

  it("prices the one-hour cache tier at twice input for modern models", () => {
    const rate = rateFor("claude", "claude-fable-5");
    assert.isNotNull(rate);
    assert.strictEqual(rate?.cacheWrite1h, 2 * (rate?.input ?? 0));
  });

  it("returns null rather than guessing at an unknown model", () => {
    assert.isNull(rateFor("claude", "claude-does-not-exist"));
    assert.isNull(rateFor("codex", "gpt-9-imaginary"));
  });

  it("prices gpt-5.6-sol at its published rate", () => {
    const rate = rateFor("codex", "gpt-5.6-sol");
    assert.isNotNull(rate);
    assert.strictEqual(rate?.input, 5 / 1_000_000);
    assert.strictEqual(rate?.output, 30 / 1_000_000);
    assert.strictEqual(rate?.cacheRead, 0.5 / 1_000_000);
  });

  it("does not match a model by prefix", () => {
    // `claude-opus-5` is a real key; a longer id that merely starts with it is
    // a different model and must not inherit its price.
    assert.isNull(rateFor("claude", "claude-opus-5-experimental"));
  });

  it("keeps the two providers' tables separate", () => {
    assert.isNull(rateFor("codex", "claude-opus-5"));
    assert.isNull(rateFor("claude", "gpt-5.5"));
  });

  it("charges nothing for cache writes on OpenAI models", () => {
    const rate = rateFor("codex", "gpt-5.5");
    assert.strictEqual(rate?.cacheWrite5m, 0);
    assert.strictEqual(rate?.cacheWrite1h, 0);
  });
});

describe("costOf", () => {
  it("is zero for an unpriced model no matter how many tokens it moved", () => {
    assert.strictEqual(costOf(null, { ...noTokens, inputTokens: 1_000_000_000 }), 0);
  });

  it("bills each token class at its own rate", () => {
    const rate = rateFor("claude", "claude-opus-5");
    const cost = costOf(rate, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    // 5 + 25 + 6.25 + 10 + 0.5
    assert.strictEqual(Math.round(cost * 100) / 100, 46.75);
  });

  it("separates the five-minute and one-hour cache tiers", () => {
    const rate = rateFor("claude", "claude-sonnet-4-5");
    const fiveMinute = costOf(rate, { ...noTokens, cacheWrite5mTokens: 1_000_000 });
    const oneHour = costOf(rate, { ...noTokens, cacheWrite1hTokens: 1_000_000 });
    assert.strictEqual(Math.round(fiveMinute * 100) / 100, 3.75);
    assert.strictEqual(Math.round(oneHour * 100) / 100, 6);
  });

  it("scales by the service-tier multiplier", () => {
    const rate = rateFor("codex", "gpt-5.5");
    const standard = costOf(rate, { ...noTokens, outputTokens: 1_000_000 });
    const priority = costOf(rate, { ...noTokens, outputTokens: 1_000_000 }, 2.5);
    assert.strictEqual(priority, standard * 2.5);
  });
});

describe("codexFastMultiplier", () => {
  it("uses the per-model multiplier where one is known", () => {
    assert.strictEqual(codexFastMultiplier("gpt-5.6-sol"), 2);
    assert.strictEqual(codexFastMultiplier("gpt-5.5"), 2.5);
    assert.strictEqual(codexFastMultiplier("gpt-5.4"), 2);
  });

  it("falls back to the default for anything else", () => {
    assert.strictEqual(codexFastMultiplier("gpt-5-codex"), DEFAULT_CODEX_FAST_MULTIPLIER);
  });
});
