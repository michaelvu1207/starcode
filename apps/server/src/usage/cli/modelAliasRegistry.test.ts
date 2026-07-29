import { assert, describe, it } from "@effect/vitest";

import { sanitizeModelAliases, toModelAliasMap } from "./modelAliasRegistry.ts";

const alias = (provider: "claude" | "codex", model: string, pricedAs: string) => ({
  provider,
  model,
  pricedAs,
});

describe("sanitizeModelAliases", () => {
  it("keeps an unknown model pointed at a priced one", () => {
    assert.deepStrictEqual(sanitizeModelAliases([alias("codex", "gpt-5.6-sol", "gpt-5.5")]), [
      alias("codex", "gpt-5.6-sol", "gpt-5.5"),
    ]);
  });

  it("drops an alias pointed at a model this build cannot price", () => {
    assert.lengthOf(sanitizeModelAliases([alias("codex", "gpt-5.6-sol", "gpt-9-imaginary")]), 0);
  });

  it("drops an alias on a model the vendored table already prices", () => {
    // Storing it would let the panel claim a borrowed price for a real rate.
    assert.lengthOf(sanitizeModelAliases([alias("codex", "gpt-5.4", "gpt-5.5")]), 0);
  });

  it("drops a self-alias", () => {
    assert.lengthOf(sanitizeModelAliases([alias("codex", "gpt-5.5", "gpt-5.5")]), 0);
  });

  it("rejects a cross-provider target", () => {
    // `claude-opus-5` is not in the Codex table, so this buys nothing.
    assert.lengthOf(sanitizeModelAliases([alias("codex", "gpt-5.6-sol", "claude-opus-5")]), 0);
  });

  it("keeps the last row for a repeated model", () => {
    const result = sanitizeModelAliases([
      alias("codex", "gpt-5.6-sol", "gpt-5.4"),
      alias("codex", "gpt-5.6-sol", "gpt-5.5"),
    ]);
    assert.deepStrictEqual(result, [alias("codex", "gpt-5.6-sol", "gpt-5.5")]);
  });

  it("does not confuse two providers' rows for the same model name", () => {
    const result = sanitizeModelAliases([
      alias("codex", "mystery", "gpt-5.5"),
      alias("claude", "mystery", "claude-opus-5"),
    ]);
    assert.lengthOf(result, 2);
  });

  it("orders rows by provider then model, so the file does not churn", () => {
    const result = sanitizeModelAliases([
      alias("codex", "unknown", "gpt-5.5"),
      alias("codex", "fable", "gpt-5.5"),
      alias("claude", "mystery", "claude-opus-5"),
    ]);
    assert.deepStrictEqual(
      result.map((entry) => `${entry.provider}/${entry.model}`),
      ["claude/mystery", "codex/fable", "codex/unknown"],
    );
  });
});

describe("toModelAliasMap", () => {
  it("nests by provider then model", () => {
    const map = toModelAliasMap([
      alias("codex", "gpt-5.6-sol", "gpt-5.5"),
      alias("codex", "unknown", "gpt-5.4"),
      alias("claude", "mystery", "claude-opus-5"),
    ]);
    assert.strictEqual(map.get("codex")?.get("gpt-5.6-sol"), "gpt-5.5");
    assert.strictEqual(map.get("codex")?.get("unknown"), "gpt-5.4");
    assert.strictEqual(map.get("claude")?.get("mystery"), "claude-opus-5");
    assert.strictEqual(map.get("claude")?.get("gpt-5.6-sol"), undefined);
  });

  it("returns an empty map for no aliases", () => {
    assert.strictEqual(toModelAliasMap([]).size, 0);
  });
});
