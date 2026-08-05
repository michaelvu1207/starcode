import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@starcode/contracts";

import {
  accountBlindModelKey,
  dedupeAccountBlindModels,
  getModelFamilyPresentation,
  getModelPickerMetadata,
  isCurrentAccountBlindModel,
} from "./providerIconUtils";

describe("account-blind model presentation", () => {
  it("shows only GPT 5.6 and Claude 5 generations in their family rails", () => {
    expect(
      isCurrentAccountBlindModel({ slug: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol" }),
    ).toBe(true);
    expect(isCurrentAccountBlindModel({ slug: "openai-codex/gpt-5.5", name: "GPT-5.5" })).toBe(
      false,
    );
    expect(
      isCurrentAccountBlindModel({ slug: "anthropic/claude-opus-5", name: "Claude Opus 5" }),
    ).toBe(true);
    expect(
      isCurrentAccountBlindModel({ slug: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1" }),
    ).toBe(false);
    expect(
      isCurrentAccountBlindModel({
        slug: "anthropic/claude-opus-4-5",
        name: "Claude Opus 4.5 (latest)",
      }),
    ).toBe(false);
    expect(
      isCurrentAccountBlindModel({ slug: "openrouter/qwen/qwen3.8-max", name: "Qwen3.8 Max" }),
    ).toBe(true);
    expect(
      isCurrentAccountBlindModel({
        slug: "openrouter/deepseek/deepseek-v4-flash-0731",
        name: "DeepSeek V4 Flash 0731",
      }),
    ).toBe(true);
    expect(
      isCurrentAccountBlindModel({
        slug: "openrouter/openai/gpt-5.6-sol",
        name: "OpenAI: GPT-5.6 Sol",
      }),
    ).toBe(false);
  });

  it("presents Pi Anthropic models as Claude without an account label", () => {
    const model = {
      slug: "anthropic/claude-opus-5",
      name: "Claude Opus 5",
      subProvider: "Anthropic",
    };
    expect(getModelFamilyPresentation(model, ProviderDriverKind.make("pi"))).toMatchObject({
      key: "claude",
      label: "Claude",
      iconDriverKind: "claudeAgent",
    });
    expect(accountBlindModelKey(model)).toBe("claude:claude-opus-5");
  });

  it("presents both OpenAI and Codex-backed GPT models as GPT", () => {
    for (const slug of ["openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol"]) {
      expect(
        getModelFamilyPresentation({ slug, name: "GPT-5.6 Sol" }, ProviderDriverKind.make("pi")),
      ).toMatchObject({ key: "gpt", label: "GPT", iconDriverKind: "codex" });
    }
    expect(
      ["openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol"].map((slug) =>
        accountBlindModelKey({ slug, name: "GPT-5.6 Sol" }),
      ),
    ).toEqual(["gpt:gpt-5.6-sol", "gpt:gpt-5.6-sol"]);
  });

  it("deduplicates account and auth-mode copies while preserving the preferred route", () => {
    const preferred = {
      instanceId: "ccc_openai_preferred",
      slug: "openai-codex/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
    };
    expect(
      dedupeAccountBlindModels([
        preferred,
        {
          instanceId: "ccc_openai_other",
          slug: "openai/gpt-5.6-sol",
          name: "GPT-5.6 Sol",
        },
      ]),
    ).toEqual([preferred]);
  });

  it("keeps exact backend slugs in non-account metadata", () => {
    expect(
      getModelPickerMetadata(
        {
          slug: "openai-codex/gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          subProvider: "OpenAI",
        },
        "GPT",
      ),
    ).toBe("GPT · OpenAI · openai-codex/gpt-5.6-sol");
  });
});
