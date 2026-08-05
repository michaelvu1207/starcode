import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSettings, ProviderInstanceId, ServerProvider } from "@starcode/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  makePiProviderSnapshot,
  makePiProviderSnapshotEffects,
  piInstanceEnvironment,
  piModelCapabilities,
} from "./PiDriver.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

const model = (provider: string, id: string): Model<any> => ({
  provider,
  id,
  name: id,
  api: "openai-responses",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
});

describe("Pi provider snapshots", () => {
  it("does not leak ambient provider credentials into catalog-bound accounts", () => {
    const config = decodePiSettings({
      catalogAccountId: "ccc_anthropic_aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      piInstanceEnvironment(
        [{ name: "ANTHROPIC_OAUTH_TOKEN", value: "explicit", sensitive: true }],
        config,
        {
          ANTHROPIC_API_KEY: "ambient-anthropic",
          OPENAI_API_KEY: "ambient-openai",
        },
      ),
    ).toEqual({ ANTHROPIC_OAUTH_TOKEN: "explicit" });
  });

  it("marks catalog accounts selectable while hiding the historical pi alias", () => {
    const modelRegistry = {
      getAvailable: () => [model("openai-codex", "gpt-5.6-sol")],
      getProviderDisplayName: (provider: string) => provider,
      refresh: async () => undefined,
      hasConfiguredAuth: () => true,
    };
    const account = makePiProviderSnapshot({
      instanceId: ProviderInstanceId.make("ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa"),
      displayName: "OpenAI Personal",
      accentColor: undefined,
      enabled: true,
      config: decodePiSettings({
        catalogAccountId: "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      modelRegistry,
    });
    const alias = makePiProviderSnapshot({
      instanceId: ProviderInstanceId.make("pi"),
      displayName: "Pi · OpenAI Personal",
      accentColor: undefined,
      enabled: true,
      config: decodePiSettings({
        catalogAccountId: "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      modelRegistry,
    });

    expect(account).toMatchObject({
      instanceSource: "catalog",
      selectable: true,
    });
    expect(alias).toMatchObject({
      instanceSource: "catalog",
      selectable: false,
    });
  });

  it("offers all explicit Pi context presets for GPT-5.6 Sol", () => {
    const capabilities = piModelCapabilities({
      ...model("openai-codex", "gpt-5.6-sol"),
      contextWindow: 272_000,
    });
    expect(capabilities.optionDescriptors).toContainEqual({
      id: "context",
      label: "Context",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "600k", label: "600k", isDefault: true },
        { id: "1m", label: "1M" },
      ],
      currentValue: "600k",
    });
  });

  it.each([
    ["openai-codex", "gpt-5.6-sol", 272_000, ["200k", "600k", "1m"], "600k"],
    ["anthropic", "claude-opus-5", 1_000_000, ["200k", "600k", "1m"], "600k"],
    ["anthropic", "claude-fable-5", 1_000_000, ["200k", "600k", "1m"], "600k"],
  ])(
    "advertises safe context and high effort for %s/%s",
    (provider, id, ceiling, choices, defaultChoice) => {
      const capabilities = piModelCapabilities({ ...model(provider, id), contextWindow: ceiling });
      const context = capabilities.optionDescriptors.find(
        (descriptor) => descriptor.id === "context",
      );
      expect(context?.currentValue).toBe(defaultChoice);
      expect(context?.options.map((option) => option.id)).toEqual(choices);
      expect(
        capabilities.optionDescriptors
          .find((descriptor) => descriptor.id === "effort")
          ?.options.map((option) => option.id),
      ).toContain("high");
    },
  );

  it("advertises the explicit Pi context presets on an arbitrary model", () => {
    const capabilities = piModelCapabilities(model("openai", "gpt-test"));
    expect(
      capabilities.optionDescriptors
        .find((descriptor) => descriptor.id === "context")
        ?.options.map((option) => option.id),
    ).toEqual(["200k", "600k", "1m"]);
  });

  it("uses the recommended 600k default even when registry metadata advertises 1M", () => {
    const context = piModelCapabilities({
      ...model("custom", "million-token-model"),
      contextWindow: 1_000_000,
    }).optionDescriptors.find((descriptor) => descriptor.id === "context");
    expect(context).toMatchObject({ currentValue: "600k" });
    expect(context?.options.map((option) => option.id)).toEqual(["200k", "600k", "1m"]);
  });

  it.effect("rebuilds the provider snapshot after refreshing model credentials", () =>
    Effect.gen(function* () {
      let available: ReadonlyArray<Model<any>> = [];
      let authenticated = false;
      let refreshes = 0;
      const modelRegistry = {
        getAvailable: () => available,
        getProviderDisplayName: (provider: string) => provider,
        refresh: async () => {
          refreshes += 1;
          authenticated = true;
          available = [model("openai-codex", "gpt-test")];
        },
        hasConfiguredAuth: (candidate: Model<any>) =>
          authenticated && candidate.provider === "openai-codex",
      };
      const snapshots = makePiProviderSnapshotEffects({
        instanceId: ProviderInstanceId.make("pi"),
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        config: decodePiSettings({}),
        modelRegistry,
      });

      const before = yield* snapshots.getSnapshot;
      assert.strictEqual(before.status, "warning");
      assert.strictEqual(before.models.length, 0);

      const after = yield* snapshots.refresh;
      assert.strictEqual(refreshes, 1);
      assert.strictEqual(after.status, "ready");
      assert.strictEqual(after.auth.status, "authenticated");
      assert.deepEqual(
        after.models.map((entry) => entry.slug),
        ["openai-codex/gpt-test"],
      );
      assert.doesNotThrow(() => decodeServerProvider(after));
    }),
  );

  it.effect("advertises launch targets from Pi's authenticated live registry", () =>
    Effect.gen(function* () {
      const credentials = new InMemoryCredentialStore();
      yield* Effect.promise(() =>
        credentials.modify("openai-codex", async () => ({
          type: "oauth",
          access: "test-openai-codex-access",
          refresh: "test-openai-codex-refresh",
          expires: Number.MAX_SAFE_INTEGER,
          accountId: "test-account",
        })),
      );
      yield* Effect.promise(() =>
        credentials.modify("anthropic", async () => ({
          type: "api_key",
          key: "test-anthropic-key",
        })),
      );
      const modelRuntime = yield* Effect.promise(() =>
        ModelRuntime.create({
          credentials,
          modelsPath: null,
          allowModelNetwork: false,
        }),
      );
      const modelRegistry = new ModelRegistry(modelRuntime);
      const snapshot = makePiProviderSnapshotEffects({
        instanceId: ProviderInstanceId.make("pi"),
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        config: decodePiSettings({}),
        modelRegistry,
      });

      const current = yield* snapshot.getSnapshot;
      expect(current.models.slice(0, 3).map(({ slug, name }) => ({ slug, name }))).toEqual([
        { slug: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { slug: "anthropic/claude-opus-5", name: "Claude Opus 5" },
        { slug: "anthropic/claude-fable-5", name: "Claude Fable 5" },
      ]);
      for (const curated of current.models.slice(0, 3)) {
        const context = curated.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "context",
        );
        expect(context?.type).toBe("select");
        if (context?.type === "select") {
          expect(context.options.map((option) => option.id)).toEqual(["200k", "600k", "1m"]);
        }
      }
    }),
  );

  it.effect("shows GPT-5.6 Sol first when it is authenticated alongside older Pi models", () =>
    Effect.gen(function* () {
      const models = [
        model("openai", "gpt-5.4"),
        { ...model("openai-codex", "gpt-5.6-sol"), name: "GPT-5.6 Sol" },
      ];
      const snapshot = makePiProviderSnapshotEffects({
        instanceId: ProviderInstanceId.make("pi"),
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        config: decodePiSettings({}),
        modelRegistry: {
          getAvailable: () => models,
          hasConfiguredAuth: (candidate) =>
            models.some((entry) => entry.provider === candidate.provider),
          getProviderDisplayName: (provider) => provider,
          refresh: async () => undefined,
        },
      });

      const current = yield* snapshot.getSnapshot;
      expect(current.models.map(({ slug, name }) => ({ slug, name }))).toEqual([
        { slug: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { slug: "openai/gpt-5.4", name: "gpt-5.4" },
      ]);
      expect(current.models[0]?.isDefault).toBe(true);
    }),
  );

  it.effect("never exposes legacy OpenCode models through Pi inventory", () =>
    Effect.gen(function* () {
      const snapshot = makePiProviderSnapshotEffects({
        instanceId: ProviderInstanceId.make("pi"),
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        config: decodePiSettings({ enabledModels: ["*"] }),
        modelRegistry: {
          getAvailable: () => [
            model("opencode", "legacy-model"),
            model("openai-codex", "gpt-5.6-sol"),
          ],
          hasConfiguredAuth: (candidate) => candidate.provider === "openai-codex",
          getProviderDisplayName: (provider) => provider,
          refresh: async () => undefined,
        },
      });

      const current = yield* snapshot.getSnapshot;
      expect(current.models.map(({ slug }) => slug)).toEqual(["openai-codex/gpt-5.6-sol"]);
    }),
  );

  it.effect("directs empty Pi inventory to reachable provider settings", () =>
    Effect.gen(function* () {
      const snapshot = makePiProviderSnapshotEffects({
        instanceId: ProviderInstanceId.make("pi"),
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        config: decodePiSettings({}),
        modelRegistry: {
          getAvailable: () => [],
          hasConfiguredAuth: () => false,
          getProviderDisplayName: (provider) => provider,
          refresh: async () => undefined,
        },
      });

      const current = yield* snapshot.getSnapshot;
      expect(current.message).toContain("Settings > Providers");
    }),
  );
});
