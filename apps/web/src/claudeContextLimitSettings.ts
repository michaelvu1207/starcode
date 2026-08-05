/**
 * Fork-owned: read the effective Claude context limit for one provider
 * instance out of an environment's settings.
 *
 * Mirrors `readInstanceCustomModels` in `modelSelection.ts`: the instance's
 * own `providerInstances[id].config` blob wins, and only *default* instances
 * fall back to the legacy per-driver `providers.claudeAgent` bucket, so a
 * limit set on `claude_work` can never leak onto the stock instance.
 *
 * The server is the authority — `ClaudeAdapter` re-resolves the same string
 * through the same shared parser. This exists purely so the composer can show
 * the operator what the server will do.
 *
 * @module claudeContextLimitSettings
 */
import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type UnifiedSettings,
} from "@starcode/contracts";
import { resolveClaudeContextLimitTokens } from "@starcode/shared/claudeContextLimit";

const CLAUDE_DRIVER_KIND = "claudeAgent";

function readConfigString(config: unknown, key: string): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The raw, unparsed setting as stored — `undefined` when this instance has
 * never been given one (i.e. it runs on the default).
 */
export function readClaudeContextLimitSetting(
  settings: Pick<UnifiedSettings, "providers" | "providerInstances">,
  instanceId: ProviderInstanceId,
): string | undefined {
  const instanceConfig = settings.providerInstances?.[instanceId]?.config;
  const fromInstance = readConfigString(instanceConfig, "contextLimitTokens");
  if (fromInstance !== undefined) {
    return fromInstance;
  }
  if (instanceId !== defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND as ProviderDriverKind)) {
    return undefined;
  }
  const legacyProviders = settings.providers as unknown as Record<
    string,
    { readonly contextLimitTokens?: string } | undefined
  >;
  return legacyProviders[CLAUDE_DRIVER_KIND]?.contextLimitTokens;
}

/** Token count the server will actually enforce for this instance. */
export function readClaudeContextLimitTokens(
  settings: Pick<UnifiedSettings, "providers" | "providerInstances">,
  instanceId: ProviderInstanceId,
): number {
  return resolveClaudeContextLimitTokens(readClaudeContextLimitSetting(settings, instanceId));
}
