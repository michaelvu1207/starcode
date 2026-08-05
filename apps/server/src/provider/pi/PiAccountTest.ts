// @effect-diagnostics globalDate:off instanceofSchema:off - measures external request latency and preserves the typed RPC error.
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAccountAuthError, type ProviderInstanceId } from "@starcode/contracts";

import { discoverPiAccounts, makePiCatalogCredentialStore } from "./PiAccountCatalog.ts";

const preferredModel = (provider: "anthropic" | "openai", models: ReadonlyArray<Model<Api>>) => {
  const preferred = provider === "openai" ? ["gpt-5.6-sol"] : ["claude-opus-5", "claude-fable-5"];
  return preferred.map((id) => models.find((model) => model.id === id)).find(Boolean) ?? models[0];
};

export async function testPiAccount(input: {
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly secretsDir: string;
}) {
  const account = (await discoverPiAccounts(input)).find(
    (candidate) => candidate.id === input.instanceId,
  );
  if (!account?.hasUsableCredential) {
    throw new PiAccountAuthError({
      reason: "not_found",
      message: "This Pi account has no usable credential.",
    });
  }
  const credentials = await makePiCatalogCredentialStore({ ...input, accountId: input.instanceId });
  try {
    const runtime = await ModelRuntime.create({
      ...(credentials ? { credentials } : { authPath: `${account.agentDir}/auth.json` }),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const providerId = account.provider === "openai" ? "openai-codex" : "anthropic";
    const models = await runtime.getAvailable(providerId);
    const model = preferredModel(account.provider, models);
    if (!model) throw new Error("No authenticated model is available for this subscription.");
    const startedAt = Date.now();
    const response = await runtime.completeSimple(
      model,
      { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: startedAt }] },
      { reasoning: "minimal", maxTokens: 8 },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? "The provider rejected the sample request.");
    }
    return {
      instanceId: input.instanceId,
      model: `${model.provider}/${model.id}`,
      latencyMs: Date.now() - startedAt,
    };
  } catch (cause) {
    throw cause instanceof PiAccountAuthError
      ? cause
      : new PiAccountAuthError({
          reason: "test_failed",
          message: cause instanceof Error ? cause.message : "The sample request failed.",
        });
  }
}
