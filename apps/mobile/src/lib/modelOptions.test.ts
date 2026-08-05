import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@starcode/contracts";

import {
  buildModelOptions,
  isRemovedProviderThreadReadOnly,
  modelOptionDetailLabel,
  resolveActiveModelSelection,
  unavailableModelGuidance,
} from "./modelOptions";

describe("mobile model options", () => {
  it("normalizes a persisted Pi selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "pi",
          driver: "pi",
          displayName: "Pi",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("pi"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("shows the Pi subprovider and exact model slug in native model menus", () => {
    const options = buildModelOptions(
      {
        providers: [
          {
            instanceId: "pi",
            driver: "pi",
            displayName: "Pi",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [
              {
                slug: "openai-codex/gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                subProvider: "OpenAI",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: "anthropic/claude-opus-5",
                name: "Claude Opus 5",
                subProvider: "Anthropic",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: "anthropic/claude-fable-5",
                name: "Claude Fable 5",
                subProvider: "Anthropic",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      } as unknown as ServerConfig,
      null,
    );

    expect(options.map(modelOptionDetailLabel)).toEqual([
      "OpenAI · openai-codex/gpt-5.6-sol",
      "Anthropic · anthropic/claude-opus-5",
      "Anthropic · anthropic/claude-fable-5",
    ]);
  });

  it("hides the historical pi alias and keeps catalog accounts out of presentation", () => {
    const options = buildModelOptions(
      {
        providers: [
          {
            instanceId: "pi",
            driver: "pi",
            displayName: "Pi · OpenAI Personal",
            selectable: false,
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [
              {
                slug: "openai-codex/gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
          {
            instanceId: "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa",
            driver: "pi",
            displayName: "OpenAI Personal",
            instanceSource: "catalog",
            selectable: true,
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [
              {
                slug: "openai-codex/gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      } as unknown as ServerConfig,
      null,
    );

    expect(options).toMatchObject([
      {
        providerKey: "gpt",
        providerLabel: "GPT",
        providerDriver: "codex",
        selection: { instanceId: "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa" },
      },
    ]);
  });

  it("deduplicates the same logical model across Pi accounts and backend auth modes", () => {
    const options = buildModelOptions(
      {
        providers: [
          {
            instanceId: "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa",
            driver: "pi",
            instanceSource: "catalog",
            selectable: true,
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [
              {
                slug: "openai/gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
          {
            instanceId: "ccc_openai_bbbbbbbbbbbbbbbbbbbbbbbb",
            driver: "pi",
            instanceSource: "catalog",
            selectable: true,
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [
              {
                slug: "openai-codex/gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      } as unknown as ServerConfig,
      null,
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ providerLabel: "GPT", providerDriver: "codex" });
  });

  it("distinguishes an unavailable Pi model from a retired runtime", () => {
    expect(
      unavailableModelGuidance(null, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      }),
    ).toBe("This legacy model is read-only. Start a new Pi task to continue.");
    expect(
      unavailableModelGuidance(null, {
        instanceId: ProviderInstanceId.make("pi"),
        model: "openai-codex/gpt-5.6-sol",
      }),
    ).toContain("This Pi model is unavailable");
  });

  it("keeps a migrated Pi selector read-only when its session belongs to a retired runtime", () => {
    expect(
      isRemovedProviderThreadReadOnly(
        {
          providers: [
            {
              instanceId: "pi",
              driver: "pi",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              models: [],
            },
          ],
        } as unknown as ServerConfig,
        {
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "openai-codex/gpt-5.6-sol",
          },
          session: {
            providerName: "codex",
          },
        } as never,
      ),
    ).toBe(true);
  });

  it.each(["codex_personal", "deleted-provider", "unknown-instance"])(
    "keeps a sessionless removed selection %s read-only",
    (instanceId) => {
      expect(
        isRemovedProviderThreadReadOnly(null, {
          modelSelection: {
            instanceId: ProviderInstanceId.make(instanceId),
            model: "legacy-model",
          },
          session: null,
        }),
      ).toBe(true);
    },
  );

  it("advertises only Pi when stale native and OpenCode snapshots are present", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "claude-opus-5",
              name: "Claude Opus 5",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: "cursor",
          driver: "cursor",
          displayName: "Cursor",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "cursor-test",
              name: "Cursor Test",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: "grok",
          driver: "grok",
          displayName: "Grok",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "grok-test",
              name: "Grok Test",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: "pi",
          driver: "pi",
          displayName: "Pi",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "openai-codex/gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: "legacy-open-code",
          driver: "opencode",
          displayName: "OpenCode",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "openai/gpt-test",
              name: "Legacy GPT Test",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(buildModelOptions(config, null).map((option) => option.key)).toEqual([
      "pi:openai-codex/gpt-5.6-sol",
    ]);
  });

  it("does not restore a persisted OpenCode selection as an active fallback", () => {
    const config = {
      providers: [],
    } as unknown as ServerConfig;

    expect(
      buildModelOptions(config, {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "openai/gpt-test",
      }),
    ).toEqual([]);
  });

  it("does not restore a custom OpenCode instance as an active fallback", () => {
    const config = {
      providers: [
        {
          instanceId: "legacy-open-code",
          driver: "opencode",
          displayName: "OpenCode",
          enabled: false,
          installed: false,
          auth: { status: "unknown" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    expect(
      buildModelOptions(config, {
        instanceId: ProviderInstanceId.make("legacy-open-code"),
        model: "openai/gpt-test",
      }),
    ).toEqual([]);
  });

  it("does not silently remap a retired selection to a supported default", () => {
    const options = buildModelOptions(
      {
        providers: [
          {
            instanceId: "pi",
            driver: "pi",
            displayName: "Pi",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [
              {
                slug: "gpt-test",
                name: "GPT Test",
                isDefault: true,
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        ],
      } as unknown as ServerConfig,
      null,
    );

    expect(
      resolveActiveModelSelection(options, {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "openai/gpt-test",
      }),
    ).toBeNull();
    expect(resolveActiveModelSelection(options, null)).toEqual({
      instanceId: "pi",
      model: "gpt-test",
    });
  });
});
