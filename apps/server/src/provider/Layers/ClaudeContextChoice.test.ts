/**
 * Fork: the per-model context mapping.
 *
 * One user-facing choice (200k / 600k / 1M) has to produce two correct things
 * per model — the API model id and the compaction point — and the failure mode
 * on the first is an id the API rejects. So every model is asserted here
 * rather than a representative sample.
 */
import { ProviderInstanceId } from "@starcode/contracts";
import { assert, describe, it } from "@effect/vitest";
import { createModelSelection } from "@starcode/shared/model";

import {
  resolveClaudeApiModelId,
  resolveClaudeContextChoice,
  resolveClaudeContextTokens,
} from "./ClaudeProvider.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");

function selection(model: string, context?: string) {
  return createModelSelection(INSTANCE, model, context ? [{ id: "context", value: context }] : []);
}

/** Models that reach 1M by opting in — the only ones `[1m]` is legal for. */
const OPT_IN_1M = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
] as const;
/** Always 1M at the API; the suffix is not a valid id for these. */
const NATIVE_1M = ["claude-opus-4-8", "claude-opus-4-7"] as const;
/** No 1M window exists. */
const FIXED_200K = ["claude-opus-4-5", "claude-haiku-4-5"] as const;

describe("claude context choice -> api model id", () => {
  it("opts into the 1M window only above 200k, and only where opting in is possible", () => {
    for (const model of OPT_IN_1M) {
      assert.equal(resolveClaudeApiModelId(selection(model, "200k")), model);
      assert.equal(resolveClaudeApiModelId(selection(model, "600k")), `${model}[1m]`);
      assert.equal(resolveClaudeApiModelId(selection(model, "1m")), `${model}[1m]`);
    }
  });

  it("never suffixes a natively-1M model, at any choice", () => {
    for (const model of NATIVE_1M) {
      for (const context of ["200k", "600k", "1m"]) {
        assert.equal(resolveClaudeApiModelId(selection(model, context)), model);
      }
    }
  });

  it("never suffixes a model with no 1M window, even when asked for one", () => {
    for (const model of FIXED_200K) {
      for (const context of ["200k", "600k", "1m"]) {
        assert.equal(resolveClaudeApiModelId(selection(model, context)), model);
      }
    }
  });

  it("never suffixes an unknown custom slug", () => {
    assert.equal(resolveClaudeApiModelId(selection("my-custom-model", "1m")), "my-custom-model");
  });
});

describe("claude context choice -> compaction point", () => {
  it("compacts at the chosen size wherever the choice is offered", () => {
    for (const model of [...OPT_IN_1M, ...NATIVE_1M]) {
      assert.equal(resolveClaudeContextTokens(selection(model, "200k")), 200_000);
      assert.equal(resolveClaudeContextTokens(selection(model, "600k")), 600_000);
      assert.equal(resolveClaudeContextTokens(selection(model, "1m")), 1_000_000);
    }
  });

  it("offers 200k alone on models with no 1M window", () => {
    for (const model of FIXED_200K) {
      assert.equal(resolveClaudeContextChoice(selection(model)), "200k");
      assert.equal(resolveClaudeContextTokens(selection(model)), 200_000);
    }
  });

  it("falls back to the instance default for a model with no context descriptor", () => {
    assert.equal(resolveClaudeContextChoice(selection("my-custom-model")), undefined);
    assert.equal(resolveClaudeContextTokens(selection("my-custom-model"), 1_000_000), 1_000_000);
    assert.equal(resolveClaudeContextTokens(selection("my-custom-model")), 600_000);
  });
});

describe("degrading a stale choice", () => {
  it("reads back 200k when a 600k thread is switched onto a 200k-only model", () => {
    for (const model of FIXED_200K) {
      assert.equal(resolveClaudeContextChoice(selection(model, "600k")), "200k");
      assert.equal(resolveClaudeContextTokens(selection(model, "600k")), 200_000);
      assert.equal(resolveClaudeContextChoice(selection(model, "1m")), "200k");
      // The degraded value is also what the API sees — never a stale suffix.
      assert.equal(resolveClaudeApiModelId(selection(model, "1m")), model);
    }
  });

  it("ignores a value that is not a context size at all", () => {
    assert.equal(resolveClaudeContextChoice(selection("claude-fable-5", "900k")), "600k");
    assert.equal(resolveClaudeContextChoice(selection("claude-fable-5", "")), "600k");
  });
});

describe("an instance that has configured a default", () => {
  it("starts every model there, not on the model's own size", () => {
    assert.equal(resolveClaudeContextChoice(selection("claude-fable-5"), 1_000_000), "1m");
    assert.equal(resolveClaudeContextChoice(selection("claude-sonnet-5"), 1_000_000), "1m");
    assert.equal(resolveClaudeContextChoice(selection("claude-fable-5"), 200_000), "200k");
  });

  it("loses to the thread's own choice", () => {
    assert.equal(
      resolveClaudeContextChoice(selection("claude-fable-5", "200k"), 1_000_000),
      "200k",
    );
    assert.equal(
      resolveClaudeApiModelId(selection("claude-fable-5", "200k"), 1_000_000),
      "claude-fable-5",
    );
  });

  it("rounds down to a size the model offers rather than up", () => {
    // 400k is a legal setting value but not a choice; it must not become 600k.
    assert.equal(resolveClaudeContextChoice(selection("claude-fable-5"), 400_000), "200k");
    assert.equal(resolveClaudeContextChoice(selection("claude-haiku-4-5"), 1_000_000), "200k");
  });
});

describe("an instance with no configured default reproduces today's behavior", () => {
  it("starts each model on what the old window-plus-600k-cap pair gave it", () => {
    // 1M-capable models were capped at 600k by the fork's old compaction cap.
    assert.equal(resolveClaudeContextTokens(selection("claude-fable-5")), 600_000);
    assert.equal(resolveClaudeContextTokens(selection("claude-opus-5")), 600_000);
    assert.equal(resolveClaudeContextTokens(selection("claude-opus-4-6")), 600_000);
    // Natively 1M, same cap.
    assert.equal(resolveClaudeContextTokens(selection("claude-opus-4-8")), 600_000);
    assert.equal(resolveClaudeContextTokens(selection("claude-opus-4-7")), 600_000);
    // Sonnet is 200k-default in Claude Code, so the cap never bound below it.
    assert.equal(resolveClaudeContextTokens(selection("claude-sonnet-5")), 200_000);
    assert.equal(resolveClaudeContextTokens(selection("claude-sonnet-4-6")), 200_000);
    // No 1M window at all.
    assert.equal(resolveClaudeContextTokens(selection("claude-opus-4-5")), 200_000);
    assert.equal(resolveClaudeContextTokens(selection("claude-haiku-4-5")), 200_000);
  });

  it("keeps the model ids those defaults used to produce", () => {
    assert.equal(resolveClaudeApiModelId(selection("claude-fable-5")), "claude-fable-5[1m]");
    assert.equal(resolveClaudeApiModelId(selection("claude-sonnet-5")), "claude-sonnet-5");
    assert.equal(resolveClaudeApiModelId(selection("claude-opus-4-8")), "claude-opus-4-8");
    assert.equal(resolveClaudeApiModelId(selection("claude-haiku-4-5")), "claude-haiku-4-5");
  });
});
