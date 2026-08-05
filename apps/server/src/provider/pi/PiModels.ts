// @effect-diagnostics nodeBuiltinImport:off - Pi's SDK accepts native filesystem paths.
import * as NodePath from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { PiSettings } from "@starcode/contracts";

import { makePiCatalogCredentialStore } from "./PiAccountCatalog.ts";

export const PREFERRED_PI_MODELS: ReadonlyArray<string> = [
  "openai-codex/gpt-5.6-sol",
  "anthropic/claude-opus-5",
  "anthropic/claude-fable-5",
];

const PROVIDER_KEY_ENVIRONMENT: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "anthropic",
  ANTHROPIC_OAUTH_TOKEN: "anthropic",
  OPENAI_API_KEY: "openai",
  AZURE_OPENAI_API_KEY: "azure-openai-responses",
  GEMINI_API_KEY: "google",
  GOOGLE_CLOUD_API_KEY: "google-vertex",
  XAI_API_KEY: "xai",
  OPENROUTER_API_KEY: "openrouter",
  GROQ_API_KEY: "groq",
  CEREBRAS_API_KEY: "cerebras",
  DEEPSEEK_API_KEY: "deepseek",
  MISTRAL_API_KEY: "mistral",
  ZAI_API_KEY: "zai",
  AI_GATEWAY_API_KEY: "vercel-ai-gateway",
  KIMI_API_KEY: "kimi-coding",
};

export interface PiModelRuntime {
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
}

export interface PiAvailableModelRegistry {
  readonly getAvailable: () => ReadonlyArray<Model<any>>;
}

class StarcodePiModelRegistry extends ModelRegistry {
  private readonly starcodeRuntime: ModelRuntime;

  constructor(starcodeRuntime: ModelRuntime) {
    super(starcodeRuntime);
    this.starcodeRuntime = starcodeRuntime;
  }

  override async refresh(): Promise<void> {
    await this.starcodeRuntime.refresh({ allowNetwork: false });
  }
}

export async function makePiModelRuntime(input: {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly instanceId: string;
  readonly config: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<PiModelRuntime> {
  const agentDir =
    input.config.agentDir.trim().length > 0
      ? NodePath.resolve(input.config.agentDir)
      : NodePath.join(input.stateDir, "pi", input.instanceId);
  const catalogCredentials = input.config.catalogAccountId
    ? await makePiCatalogCredentialStore({
        stateDir: input.stateDir,
        secretsDir: input.secretsDir,
        accountId: input.config.catalogAccountId,
      })
    : undefined;
  const modelRuntime = await ModelRuntime.create({
    ...(catalogCredentials
      ? { credentials: catalogCredentials }
      : { authPath: NodePath.join(agentDir, "auth.json") }),
    modelsPath: NodePath.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const catalogProvider = /^(?:ccc|starcode)_anthropic_/u.test(input.config.catalogAccountId)
    ? "anthropic"
    : /^(?:ccc|starcode)_openai_/u.test(input.config.catalogAccountId)
      ? "openai"
      : undefined;
  for (const [environmentName, provider] of Object.entries(PROVIDER_KEY_ENVIRONMENT)) {
    if (catalogProvider !== undefined && provider !== catalogProvider) continue;
    const value = input.environment[environmentName]?.trim();
    if (value) await modelRuntime.setRuntimeApiKey(provider, value, { allowNetwork: false });
  }
  const modelRegistry = new StarcodePiModelRegistry(modelRuntime);
  return { agentDir, modelRuntime, modelRegistry };
}

export function piModelSlug(model: Pick<Model<any>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function resolvePiModel(
  registry: PiAvailableModelRegistry,
  slug: string | undefined,
  enabledModels: ReadonlyArray<string>,
): Model<any> | undefined {
  const available = filterPiModels(availablePiModels(registry), enabledModels);
  if (slug) {
    const exact = available.find((candidate) => piModelSlug(candidate) === slug);
    return exact;
  }
  return (
    PREFERRED_PI_MODELS.map((preferred) =>
      available.find((candidate) => piModelSlug(candidate) === preferred),
    ).find((candidate) => candidate !== undefined) ?? available[0]
  );
}

export function availablePiModels(registry: PiAvailableModelRegistry): ReadonlyArray<Model<any>> {
  return registry.getAvailable();
}

export function filterPiModels(
  models: ReadonlyArray<Model<any>>,
  enabledModels: ReadonlyArray<string>,
): ReadonlyArray<Model<any>> {
  const available = models.filter(
    (model) => isSupportedPiModel(model) && modelEnabled(model, enabledModels),
  );
  const preferred = new Map(PREFERRED_PI_MODELS.map((slug, index) => [slug, index]));
  return available
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      const leftRank = preferred.get(piModelSlug(left.model)) ?? Number.POSITIVE_INFINITY;
      const rightRank = preferred.get(piModelSlug(right.model)) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ model }) => model);
}

function isSupportedPiModel(model: Pick<Model<any>, "provider">): boolean {
  // OpenCode is retained only as a legacy history identifier. Pi must not
  // make it launchable again through a stored credential or custom model.
  return model.provider !== "opencode";
}

function modelEnabled(model: Model<any>, patterns: ReadonlyArray<string>): boolean {
  if (patterns.length === 0) return true;
  const slug = piModelSlug(model);
  return patterns.some((pattern) => {
    if (pattern === slug) return true;
    if (!pattern.includes("*")) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(slug);
  });
}
