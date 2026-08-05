import { ProviderDriverKind } from "@starcode/contracts";
import { ClaudeAI, CursorIcon, GrokIcon, Icon, OpenAI } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const GPT_DRIVER = ProviderDriverKind.make("codex");

export type ModelFamilyPresentation = {
  readonly key: "claude" | "gpt" | "other";
  readonly label: string;
  readonly iconDriverKind: ProviderDriverKind;
};

/**
 * Pi owns execution, but the model picker presents the model backend rather
 * than the credential account or runtime. This keeps account identity in
 * Connections while retaining the real instance id as the routing key.
 */
export function getModelFamilyPresentation(
  model: ModelEsque,
  fallbackDriverKind: ProviderDriverKind,
): ModelFamilyPresentation {
  const identity = `${model.subProvider ?? ""} ${model.slug} ${model.name}`.toLowerCase();
  if (identity.includes("anthropic") || identity.includes("claude")) {
    return { key: "claude", label: "Claude", iconDriverKind: CLAUDE_DRIVER };
  }
  if (
    identity.includes("openai") ||
    identity.includes("codex") ||
    /(?:^|\W)gpt(?:\W|$)/u.test(identity)
  ) {
    return { key: "gpt", label: "GPT", iconDriverKind: GPT_DRIVER };
  }
  return { key: "other", label: "Model", iconDriverKind: fallbackDriverKind };
}

export function accountBlindModelKey(model: ModelEsque): string {
  const family = getModelFamilyPresentation(model, ProviderDriverKind.make("pi"));
  const backendBlindSlug = model.slug.replace(/^(?:anthropic|openai(?:-codex)?)[/:]/iu, "");
  return `${family.key}:${backendBlindSlug.toLowerCase()}`;
}

export function dedupeAccountBlindModels<T extends ModelEsque>(models: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = accountBlindModelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keep the account-blind picker focused on Starcode's current model generations. */
export function isCurrentAccountBlindModel(model: ModelEsque): boolean {
  const presentation = getModelFamilyPresentation(model, ProviderDriverKind.make("pi"));
  const identity = `${model.slug} ${model.name}`.toLowerCase();
  if (model.slug.toLowerCase().startsWith("openrouter/")) {
    return (
      model.slug.toLowerCase() === "openrouter/deepseek/deepseek-v4-flash-0731" ||
      model.slug.toLowerCase() === "openrouter/qwen/qwen3.8-max"
    );
  }
  if (presentation.key === "gpt") return /gpt[-\s]?5\.6(?:\W|$)/u.test(identity);
  if (presentation.key === "claude") {
    return /claude\s+(?:opus|fable|sonnet|haiku)\s+5(?:\W|$)/iu.test(model.name);
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}

export function getModelPickerMetadata(model: ModelEsque, providerDisplayName: string): string {
  const providerLabel = model.subProvider
    ? `${providerDisplayName} · ${model.subProvider}`
    : providerDisplayName;
  return model.slug === getDisplayModelName(model)
    ? providerLabel
    : `${providerLabel} · ${model.slug}`;
}
