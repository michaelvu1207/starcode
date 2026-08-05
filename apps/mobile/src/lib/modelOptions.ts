import type {
  ModelCapabilities,
  ModelSelection,
  OrchestrationThreadShell,
  ServerConfig as StarcodeServerConfig,
} from "@starcode/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@starcode/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly subProvider: string | null;
  readonly isDefault: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

const LAUNCHABLE_PROVIDER_DRIVER = "pi";

function isActiveProvider(provider: StarcodeServerConfig["providers"][number]): boolean {
  return (
    provider.driver === LAUNCHABLE_PROVIDER_DRIVER &&
    provider.selectable !== false &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
  );
}

function isActiveFallbackSelection(
  config: StarcodeServerConfig | null | undefined,
  selection: ModelSelection,
): boolean {
  const configuredProvider = config?.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  );
  // A persisted selection may be displayed only when its provider is still an
  // active capability in the current server snapshot. Historical threads can
  // therefore retain any legacy instance id without that id being inferred as
  // launchable while discovery is loading or after a provider is retired.
  return configuredProvider !== undefined && isActiveProvider(configuredProvider);
}

function modelFamily(input: {
  readonly slug: string;
  readonly name: string;
  readonly subProvider?: string | undefined;
}): { readonly key: "claude" | "gpt" | "model"; readonly label: string; readonly driver: string } {
  const identity = `${input.subProvider ?? ""} ${input.slug} ${input.name}`.toLowerCase();
  if (identity.includes("anthropic") || identity.includes("claude")) {
    return { key: "claude", label: "Claude", driver: "claudeAgent" };
  }
  if (
    identity.includes("openai") ||
    identity.includes("codex") ||
    /(?:^|\W)gpt(?:\W|$)/u.test(identity)
  ) {
    return { key: "gpt", label: "GPT", driver: "codex" };
  }
  return { key: "model", label: "Model", driver: LAUNCHABLE_PROVIDER_DRIVER };
}

function accountBlindModelKey(input: { readonly slug: string; readonly name: string }): string {
  const family = modelFamily(input);
  const backendBlindSlug = input.slug.replace(/^(?:anthropic|openai(?:-codex)?)[/:]/iu, "");
  return `${family.key}:${backendBlindSlug.toLowerCase()}`;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

export function buildModelOptions(
  config: StarcodeServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  const providers = [...(config?.providers ?? [])].toSorted((left, right) => {
    if (left.instanceId === fallbackModelSelection?.instanceId) return -1;
    if (right.instanceId === fallbackModelSelection?.instanceId) return 1;
    return 0;
  });
  for (const provider of providers) {
    if (!isActiveProvider(provider)) {
      continue;
    }

    for (const model of provider.models) {
      const family = modelFamily(model);
      const key = accountBlindModelKey(model);
      if (options.has(key)) continue;
      options.set(key, {
        key: `${provider.instanceId}:${model.slug}`,
        label: model.name,
        subtitle: family.label,
        providerKey: family.key,
        providerLabel: family.label,
        providerDriver: family.driver,
        subProvider: model.subProvider ?? null,
        isDefault: model.isDefault === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection && isActiveFallbackSelection(config, fallbackModelSelection)) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = [...options.values()].find(
      (option) =>
        option.selection.instanceId === fallbackModelSelection.instanceId &&
        option.selection.model === fallbackModelSelection.model,
    );
    if (existing) {
      const existingMapKey = [...options].find(([, option]) => option === existing)?.[0] ?? key;
      options.set(existingMapKey, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const family = modelFamily({
        slug: fallbackModelSelection.model,
        name: fallbackModelSelection.model,
      });
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: family.label,
        providerKey: family.key,
        providerLabel: family.label,
        providerDriver: family.driver,
        subProvider: null,
        isDefault: false,
        capabilities: null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

/** Secondary copy for native model menus: account family plus the exact Pi slug. */
export function modelOptionDetailLabel(option: ModelOption): string {
  return [option.subProvider, option.selection.model].filter(Boolean).join(" · ");
}

export function unavailableModelGuidance(
  config: StarcodeServerConfig | null | undefined,
  selection: ModelSelection,
): string {
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  return provider?.driver === LAUNCHABLE_PROVIDER_DRIVER ||
    selection.instanceId === "pi" ||
    selection.instanceId.startsWith("pi_")
    ? "This Pi model is unavailable. Choose an available Pi model or start a new Pi task."
    : "This legacy model is read-only. Start a new Pi task to continue.";
}

/**
 * Existing native-provider conversations are provenance, not Pi launch input.
 * A legacy session remains authoritative even after migration moves the
 * thread's visible model selector to Pi. Sessionless threads fail closed when
 * their instance disappeared from discovery: otherwise selecting an
 * advertised Pi model would silently reactivate imported/custom legacy
 * history through a different runtime.
 */
export function isRemovedProviderThreadReadOnly(
  config: StarcodeServerConfig | null | undefined,
  thread: Pick<OrchestrationThreadShell, "modelSelection" | "session">,
): boolean {
  const sessionDriver = thread.session?.providerName;
  if (sessionDriver) return sessionDriver !== LAUNCHABLE_PROVIDER_DRIVER;

  const configured = config?.providers.find(
    (provider) => provider.instanceId === thread.modelSelection.instanceId,
  );
  if (configured) return configured.driver !== LAUNCHABLE_PROVIDER_DRIVER;

  const instanceId = String(thread.modelSelection.instanceId);
  return instanceId !== "pi" && !instanceId.startsWith("pi_");
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}

export function resolveActiveModelSelection(
  options: ReadonlyArray<ModelOption>,
  preferredSelection: ModelSelection | null,
): ModelSelection | null {
  if (preferredSelection) {
    return (
      options.find(
        (option) =>
          option.selection.instanceId === preferredSelection.instanceId &&
          option.selection.model === preferredSelection.model,
      )?.selection ?? null
    );
  }

  return options.find((option) => option.isDefault)?.selection ?? options[0]?.selection ?? null;
}
