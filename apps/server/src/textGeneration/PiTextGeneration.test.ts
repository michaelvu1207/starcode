import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSettings, ProviderInstanceId } from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const instanceId = ProviderInstanceId.make("pi-text-test");
const modelSlug = "openai-codex/gpt-5.6-sol";

async function fixture() {
  const faux = fauxProvider({
    provider: "openai-codex",
    models: [{ id: "gpt-5.6-sol", reasoning: true, contextWindow: 1_000_000 }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("openai-codex", "test-key", { allowNetwork: false });
  const registry = new ModelRegistry(modelRuntime);
  const generation = makePiTextGeneration({
    modelRegistry: registry,
    modelRuntime,
    config: decodePiSettings({ enabledModels: [modelSlug] }),
  });
  return { faux, generation };
}

describe("PiTextGeneration", () => {
  it.effect("propagates the exact Pi model, effort alias, and context choice", () => {
    let requestedModel:
      | { readonly provider: string; readonly id: string; readonly contextWindow: number }
      | undefined;
    let requestedReasoning: unknown;
    return Effect.gen(function* () {
      const test = yield* Effect.promise(fixture);
      test.faux.setResponses([
        (_context, options, _state, model) => {
          requestedModel = model;
          requestedReasoning = (options as { readonly reasoning?: unknown } | undefined)?.reasoning;
          return fauxAssistantMessage('{"title":"Pi text generation"}');
        },
      ]);
      const result = yield* test.generation.generateThreadTitle({
        cwd: process.cwd(),
        message: "Generate a title",
        modelSelection: {
          instanceId,
          model: modelSlug,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "context", value: "600k" },
          ],
        },
      });

      expect(result).toEqual({ title: "Pi text generation" });
      expect(requestedModel).toMatchObject({
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        contextWindow: 600_000,
      });
      expect(requestedReasoning).toBe("high");
    });
  });

  it.effect("rejects unsupported Pi options before making a model request", () => {
    return Effect.gen(function* () {
      const test = yield* Effect.promise(fixture);
      test.faux.setResponses([fauxAssistantMessage('{"title":"must not run"}')]);
      const result = yield* Effect.result(
        test.generation.generateThreadTitle({
          cwd: process.cwd(),
          message: "Do not generate",
          modelSelection: {
            instanceId,
            model: modelSlug,
            options: [{ id: "legacyHarnessMode", value: "codex" }],
          },
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "TextGenerationError",
          detail: expect.stringContaining("Unsupported Pi provider option 'legacyHarnessMode'"),
        },
      });
      expect(test.faux.state.callCount).toBe(0);
    });
  });
});
