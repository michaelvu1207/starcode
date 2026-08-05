// @effect-diagnostics globalDate:off globalDateInEffect:off - Provider snapshots use wire ISO timestamps.
import type { Model } from "@earendil-works/pi-ai";
import {
  defaultInstanceIdForDriver,
  PiSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { FleetSessionBootstrap } from "../FleetSessionBootstrap.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import {
  availablePiModels,
  makePiModelRuntime,
  filterPiModels,
  piModelSlug,
} from "../pi/PiModels.ts";
import { piContextChoicesForModel, piDefaultContextForModel } from "../pi/PiProviderOptions.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const PI_VERSION = "0.83.0";
const decodePiSettings = Schema.decodeSync(PiSettings);

export function piModelCapabilities(model: {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
  readonly reasoning: boolean;
  readonly input: ReadonlyArray<string>;
}) {
  const contextChoices = piContextChoicesForModel(model);
  const defaultContext = piDefaultContextForModel(model);
  return {
    optionDescriptors: [
      ...(model.reasoning
        ? [
            {
              id: "effort",
              label: "Reasoning effort",
              type: "select" as const,
              options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({
                id: value,
                label: value === "off" ? "Off" : `${value[0]!.toUpperCase()}${value.slice(1)}`,
                ...(value === "medium" ? { isDefault: true } : {}),
              })),
              currentValue: "medium",
            },
          ]
        : []),
      ...(defaultContext
        ? [
            {
              id: "context",
              label: "Context",
              type: "select" as const,
              options: contextChoices.map((value) => ({
                id: value,
                label: value === "1m" ? "1M" : value,
                ...(value === defaultContext ? { isDefault: true } : {}),
              })),
              currentValue: defaultContext,
            },
          ]
        : []),
    ],
  };
}

export type PiDriverEnv = ServerConfig | FleetSessionBootstrap;

interface PiSnapshotRegistry {
  readonly getAvailable: () => ReadonlyArray<Model<any>>;
  readonly hasConfiguredAuth: (model: Model<any>) => boolean;
  readonly getProviderDisplayName: (provider: string) => string;
  readonly refresh: () => Promise<void>;
}

interface PiProviderSnapshotInput {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly config: PiSettings;
  readonly modelRegistry: PiSnapshotRegistry;
}

export function piInstanceEnvironment(
  environment: Parameters<typeof mergeProviderInstanceEnvironment>[0],
  config: PiSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return mergeProviderInstanceEnvironment(
    environment,
    config.catalogAccountId ? {} : baseEnvironment,
  );
}

export function makePiProviderSnapshot(input: PiProviderSnapshotInput): ServerProvider {
  const models = filterPiModels(availablePiModels(input.modelRegistry), input.config.enabledModels);
  const checkedAt = new Date().toISOString();
  const catalogManaged = input.config.catalogAccountId.trim().length > 0;
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName ?? "Pi",
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: `pi:instance:${input.instanceId}` },
    showInteractionModeToggle: true,
    requiresNewThreadForModelChange: false,
    enabled: input.enabled,
    installed: true,
    version: PI_VERSION,
    status: !input.enabled ? "disabled" : models.length > 0 ? "ready" : "warning",
    auth: {
      status: models.length > 0 ? "authenticated" : "unauthenticated",
    },
    checkedAt,
    instanceSource: catalogManaged ? "catalog" : "settings",
    selectable: !catalogManaged || input.instanceId !== defaultInstanceIdForDriver(DRIVER_KIND),
    ...(models.length === 0
      ? {
          message:
            "Pi is installed but no model backend is authenticated. Manage available Pi accounts in Settings > Providers.",
        }
      : {}),
    models: models.map((model, index) => ({
      slug: piModelSlug(model),
      name: model.name,
      subProvider: input.modelRegistry.getProviderDisplayName(model.provider),
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: piModelCapabilities(model),
    })),
    slashCommands: [],
    skills: [],
  };
}

export function makePiProviderSnapshotEffects(input: PiProviderSnapshotInput) {
  const readSnapshot = () => makePiProviderSnapshot(input);
  return {
    getSnapshot: Effect.sync(readSnapshot),
    refresh: Effect.promise(() => input.modelRegistry.refresh()).pipe(Effect.map(readSnapshot)),
  };
}

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const fleetSessionBootstrap = yield* FleetSessionBootstrap;
      return yield* Effect.tryPromise({
        try: async () => {
          const runtime = await makePiModelRuntime({
            stateDir: serverConfig.stateDir,
            secretsDir: serverConfig.secretsDir,
            instanceId,
            config,
            environment: piInstanceEnvironment(environment, config),
          });
          const snapshotEffects = makePiProviderSnapshotEffects({
            instanceId,
            displayName,
            accentColor,
            enabled,
            config,
            modelRegistry: runtime.modelRegistry,
          });
          const snapshot = {
            maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: "@earendil-works/pi-coding-agent",
            }),
            ...snapshotEffects,
            streamChanges: Stream.never,
          };
          return {
            instanceId,
            driverKind: DRIVER_KIND,
            continuationIdentity: {
              driverKind: DRIVER_KIND,
              continuationKey: `pi:instance:${instanceId}`,
            },
            displayName,
            accentColor,
            enabled,
            snapshot,
            adapter: Effect.runSync(
              makePiAdapter({
                instanceId,
                config,
                agentDir: runtime.agentDir,
                attachmentsDir: serverConfig.attachmentsDir,
                modelRegistry: runtime.modelRegistry,
                modelRuntime: runtime.modelRuntime,
                fleetSessionBootstrapSnapshot: fleetSessionBootstrap.snapshot,
              }),
            ),
            textGeneration: makePiTextGeneration({
              modelRegistry: runtime.modelRegistry,
              modelRuntime: runtime.modelRuntime,
              config,
            }),
          };
        },
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    }),
};
