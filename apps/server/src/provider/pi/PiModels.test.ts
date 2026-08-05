// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Tests use isolated native state and token expiries.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSettings } from "@starcode/contracts";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  availablePiModels,
  filterPiModels,
  makePiModelRuntime,
  piModelSlug,
  resolvePiModel,
} from "./PiModels.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

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

const writeJson = (path: string, value: unknown): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

describe("Pi model selection", () => {
  it("uses provider/model slugs and trusted wildcard allowlists", () => {
    const models = [model("openai", "gpt-a"), model("anthropic", "claude-b")];
    assert.strictEqual(piModelSlug(models[0]!), "openai/gpt-a");
    assert.deepEqual(filterPiModels(models, ["openai/*"]).map(piModelSlug), ["openai/gpt-a"]);
  });

  it("selects only authenticated allowed models and degrades to undefined", () => {
    const models = [model("openai", "gpt-a")];
    const registry = { getAvailable: () => models };
    assert.strictEqual(resolvePiModel(registry, "openai/gpt-a", []), models[0]);
    assert.strictEqual(resolvePiModel(registry, "openai/gpt-a", ["anthropic/*"]), undefined);
    assert.strictEqual(resolvePiModel(registry, "anthropic/claude-b", []), undefined);
  });

  it("prefers authenticated native launch targets without hiding other models", () => {
    const models = [
      model("openai", "gpt-5.4"),
      model("openai-codex", "gpt-5.6-sol"),
      model("anthropic", "claude-opus-5"),
      model("anthropic", "claude-fable-5"),
    ];
    expect(filterPiModels(models, []).map(piModelSlug)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-opus-5",
      "anthropic/claude-fable-5",
      "openai/gpt-5.4",
    ]);
  });

  it("uses Pi 0.83's authoritative model records unchanged and refreshes idempotently", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "starcode-pi-native-"));
    const authPath = NodePath.join(stateDir, "pi", "native", "auth.json");
    writeJson(authPath, {
      "openai-codex": {
        type: "oauth",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "account-1",
      },
      anthropic: { type: "api_key", key: "anthropic-key" },
    });

    try {
      const runtime = await makePiModelRuntime({
        stateDir,
        secretsDir: NodePath.join(stateDir, "secrets"),
        instanceId: "native",
        config: decodePiSettings({}),
        environment: {},
      });
      const expected = [
        {
          slug: "openai-codex/gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          api: "openai-codex-responses",
          contextWindow: 272_000,
          maxTokens: 128_000,
        },
        {
          slug: "anthropic/claude-opus-5",
          name: "Claude Opus 5",
          api: "anthropic-messages",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
        {
          slug: "anthropic/claude-fable-5",
          name: "Claude Fable 5",
          api: "anthropic-messages",
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
      ];
      const readTargets = () =>
        expected.map(({ slug }) => {
          const [provider, id] = slug.split("/") as [string, string];
          const target = runtime.modelRegistry.find(provider, id)!;
          return {
            slug: piModelSlug(target),
            name: target.name,
            api: target.api,
            contextWindow: target.contextWindow,
            maxTokens: target.maxTokens,
          };
        });
      const count = runtime.modelRegistry.getAll().length;
      const nativeRecords = expected.map(({ slug }) => {
        const [provider, id] = slug.split("/") as [string, string];
        return structuredClone(runtime.modelRegistry.find(provider, id)!);
      });

      expect(readTargets()).toEqual(expected);
      for (const { slug } of expected) {
        expect(
          runtime.modelRegistry.getAll().filter((entry) => piModelSlug(entry) === slug),
        ).toHaveLength(1);
      }
      expect(availablePiModels(runtime.modelRegistry).map(piModelSlug)).toEqual(
        expect.arrayContaining(expected.map(({ slug }) => slug)),
      );
      expect(
        await runtime.modelRegistry.getApiKeyAndHeaders(
          runtime.modelRegistry.find("openai-codex", "gpt-5.6-sol")!,
        ),
      ).toMatchObject({
        ok: true,
        apiKey: "codex-access",
      });
      expect(
        await runtime.modelRegistry.getApiKeyAndHeaders(
          runtime.modelRegistry.find("anthropic", "claude-opus-5")!,
        ),
      ).toMatchObject({
        ok: true,
        apiKey: "anthropic-key",
      });

      await runtime.modelRegistry.refresh();
      await runtime.modelRegistry.refresh();
      expect(runtime.modelRegistry.getAll()).toHaveLength(count);
      expect(readTargets()).toEqual(expected);
      expect(
        expected.map(({ slug }) => {
          const [provider, id] = slug.split("/") as [string, string];
          return runtime.modelRegistry.find(provider, id)!;
        }),
      ).toEqual(nativeRecords);
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves custom same-slug metadata and its lower context ceiling across refresh", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "starcode-pi-custom-"));
    const agentDir = NodePath.join(stateDir, "pi", "custom");
    writeJson(NodePath.join(agentDir, "auth.json"), {
      anthropic: { type: "api_key", key: "anthropic-key" },
    });
    writeJson(NodePath.join(agentDir, "models.json"), {
      providers: {
        anthropic: {
          models: [
            {
              id: "claude-opus-5",
              name: "My Opus override",
              contextWindow: 222_000,
              maxTokens: 22_000,
            },
          ],
        },
      },
    });

    try {
      const runtime = await makePiModelRuntime({
        stateDir,
        secretsDir: NodePath.join(stateDir, "secrets"),
        instanceId: "custom",
        config: decodePiSettings({}),
        environment: {},
      });
      const expected = {
        name: "My Opus override",
        contextWindow: 222_000,
        maxTokens: 22_000,
      };
      expect(runtime.modelRegistry.find("anthropic", "claude-opus-5")).toMatchObject(expected);
      await runtime.modelRegistry.refresh();
      expect(runtime.modelRegistry.find("anthropic", "claude-opus-5")).toMatchObject(expected);
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent expired Codex OAuth refreshes and persists the rotated token", async () => {
    const credentials = new (await import("@earendil-works/pi-ai")).InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "old-refresh",
      expires: Date.now() - 1,
      accountId: "account-1",
    }));
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
    ).toString("base64url");
    const access = `header.${payload}.signature`;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: access, refresh_token: "new-refresh", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    try {
      const modelRuntime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(modelRuntime);
      const target = registry.find("openai-codex", "gpt-5.6-sol")!;
      const [first, second] = await Promise.all([
        registry.getApiKeyAndHeaders(target),
        registry.getApiKeyAndHeaders(target),
      ]);
      expect(first).toMatchObject({ ok: true, apiKey: access });
      expect(second).toMatchObject({ ok: true, apiKey: access });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await credentials.read("openai-codex")).toMatchObject({
        type: "oauth",
        access,
        refresh: "new-refresh",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
