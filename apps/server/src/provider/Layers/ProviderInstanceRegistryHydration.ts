/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistryMutableLayer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      subscribes to `ServerSettingsService.streamChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/Layers/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "../builtInDrivers.ts";
import {
  discoverPiAccounts,
  selectDefaultPiAccount,
  type DiscoveredPiAccount,
} from "../pi/PiAccountCatalog.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Materialize each catalogued Pi account as an identity-preserving
 *      provider instance and bind the legacy `pi` key to a usable default.
 *   2. Overlay legacy built-in settings, then explicit provider instances.
 *      User-authored presentation/config wins without dropping the hidden
 *      catalog credential route.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
  discoveredPiAccounts: ReadonlyArray<DiscoveredPiAccount> = [],
): ProviderInstanceConfigMap => {
  // Pi is Starcode's only execution runtime. Keep legacy provider settings
  // readable in ServerSettings so old installations round-trip safely, but
  // never hydrate Claude Code, Codex app-server, or another harness into a
  // runnable/shadow provider. Anthropic and OpenAI are model backends inside
  // Pi, not Starcode provider drivers.
  const merged: Record<string, ProviderInstanceConfig> = {};

  for (const account of discoveredPiAccounts) {
    merged[account.id] = {
      driver: BUILT_IN_DRIVERS[0]!.driverKind,
      displayName:
        account.credentialSource === "claude-code"
          ? `${account.label} · Current Claude Code login`
          : account.credentialSource === "claude-manager"
            ? `${account.label} · Saved Claude login`
            : account.credentialSource === "codex"
              ? `${account.label} · Current Codex login`
              : account.label,
      enabled: account.status !== "disabled",
      config: {
        agentDir: account.agentDir,
        catalogAccountId: account.id,
      },
    };
  }

  // Keep the historical `pi` routing key launchable for existing projects,
  // threads, and runtime rows. It uses the selected account's credential
  // store directly while retaining the old Pi session directory.
  const defaultAccount = selectDefaultPiAccount(discoveredPiAccounts);
  if (defaultAccount) {
    merged.pi = {
      driver: BUILT_IN_DRIVERS[0]!.driverKind,
      displayName: `Pi · ${defaultAccount.label}`,
      config: {
        agentDir: defaultAccount.agentDir,
        catalogAccountId: defaultAccount.id,
      },
    };
  }

  const configRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const overlay = (
    instanceId: string,
    discovered: ProviderInstanceConfig | undefined,
    configured: ProviderInstanceConfig,
  ): ProviderInstanceConfig => {
    if (!discovered) return configured;
    const discoveredConfig = configRecord(discovered.config) ?? {};
    const configuredConfig = configRecord(configured.config) ?? {};
    const configuredAgentDir =
      typeof configuredConfig.agentDir === "string" ? configuredConfig.agentDir.trim() : "";
    const discoveredAgentDir =
      typeof discoveredConfig.agentDir === "string" ? discoveredConfig.agentDir.trim() : "";
    const usesIndependentAgentDirectory =
      configuredAgentDir.length > 0 && configuredAgentDir !== discoveredAgentDir;
    const configuredOverlay = Object.fromEntries(
      Object.entries(configuredConfig).filter(
        ([key, value]) =>
          !(
            (key === "catalogAccountId" || key === "agentDir") &&
            typeof value === "string" &&
            value.trim().length === 0
          ),
      ),
    );
    if (usesIndependentAgentDirectory && instanceId === "pi") {
      return {
        ...configured,
        displayName: configured.displayName ?? "Pi",
        config: configuredConfig,
      };
    }
    return {
      ...discovered,
      ...configured,
      config: { ...discoveredConfig, ...configuredOverlay },
    };
  };

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = overlay(instanceId, merged[instanceId], {
      driver: driver.driverKind,
      config: legacyConfig,
    });
  }

  // Explicit settings remain authoritative for user-facing fields, while a
  // catalog-derived account route retains its hidden credential binding unless
  // the user deliberately selects a different non-empty Pi data directory.
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance.driver !== "pi") continue;
    merged[instanceId] = overlay(instanceId, merged[instanceId], instance);
  }

  return merged as ProviderInstanceConfigMap;
};

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
const SettingsWatcherLive = (discoveredPiAccounts: ReadonlyArray<DiscoveredPiAccount>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator;
      const serverSettings = yield* ServerSettingsService;
      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach((next) =>
          mutator
            .reconcile(deriveProviderInstanceConfigMap(next, discoveredPiAccounts))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
              ),
            ),
        ),
        Effect.forkScoped,
      );
    }),
  );

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistryMutableLayer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator and runs a daemon fiber
 *     in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
export const ProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry,
  never,
  BuiltInDriversEnv | ServerSettingsService
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const discoveredPiAccounts = yield* Effect.promise(() =>
      discoverPiAccounts({
        stateDir: serverConfig.stateDir,
        secretsDir: serverConfig.secretsDir,
      }),
    );
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings, discoveredPiAccounts);
    const mutableLayer = ProviderInstanceRegistryMutableLayer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    });

    return SettingsWatcherLive(discoveredPiAccounts).pipe(Layer.provideMerge(mutableLayer));
  }),
) as Layer.Layer<ProviderInstanceRegistry, never, BuiltInDriversEnv | ServerSettingsService>;
