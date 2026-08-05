import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");
const FakePiConfig = Schema.Struct({ label: Schema.String });
type FakePiConfig = typeof FakePiConfig.Type;

const snapshotFor = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly label: string;
}): ServerProvider => ({
  instanceId: input.instanceId,
  driver: PI_DRIVER,
  displayName: input.displayName ?? input.label,
  continuation: { groupKey: `pi:instance:${input.instanceId}` },
  enabled: input.enabled,
  installed: true,
  version: "test",
  status: input.enabled ? "ready" : "disabled",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-04T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const FakePiDriver: ProviderDriver<FakePiConfig> = {
  driverKind: PI_DRIVER,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: FakePiConfig,
  defaultConfig: () => ({ label: "Pi" }),
  create: ({ instanceId, displayName, enabled, config }) => {
    const snapshot = snapshotFor({ instanceId, displayName, enabled, label: config.label });
    return Effect.succeed({
      instanceId,
      driverKind: PI_DRIVER,
      continuationIdentity: defaultProviderContinuationIdentity({
        driverKind: PI_DRIVER,
        instanceId,
      }),
      displayName,
      enabled,
      snapshot: {
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: PI_DRIVER,
          packageName: null,
        }),
        getSnapshot: Effect.succeed(snapshot),
        refresh: Effect.succeed(snapshot),
        streamChanges: Stream.empty,
      },
      adapter: { provider: PI_DRIVER } as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    });
  },
};

describe("ProviderInstanceRegistryLive Pi-only runtime", () => {
  it.effect("materializes independent Pi instances from one config map", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const personalId = ProviderInstanceId.make("pi_personal");
        const workId = ProviderInstanceId.make("pi_work");
        const configMap: ProviderInstanceConfigMap = {
          [personalId]: {
            driver: PI_DRIVER,
            displayName: "Pi Personal",
            config: { label: "personal" },
          },
          [workId]: {
            driver: PI_DRIVER,
            displayName: "Pi Work",
            enabled: false,
            config: { label: "work" },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [FakePiDriver],
          configMap,
        });
        const instances = yield* registry.listInstances;
        expect(instances.map((instance) => instance.instanceId)).toEqual([personalId, workId]);
        expect(instances.every((instance) => instance.driverKind === PI_DRIVER)).toBe(true);
        expect(instances[0]?.adapter).not.toBe(instances[1]?.adapter);
        expect(instances[0]?.snapshot).not.toBe(instances[1]?.snapshot);
        expect((yield* instances[0]!.snapshot.getSnapshot).status).toBe("ready");
        expect((yield* instances[1]!.snapshot.getSnapshot).status).toBe("disabled");
        expect(yield* registry.listUnavailable).toEqual([]);
      }),
    ),
  );

  it.effect("keeps a removed harness config as unavailable history without materializing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const piId = ProviderInstanceId.make("pi");
        const legacyId = ProviderInstanceId.make("codex_legacy");
        const configMap: ProviderInstanceConfigMap = {
          [piId]: { driver: PI_DRIVER, config: { label: "Pi" } },
          [legacyId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Legacy Codex",
            config: { preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [FakePiDriver],
          configMap,
        });
        expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
          piId,
        ]);
        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        expect(unavailable[0]).toMatchObject({
          instanceId: legacyId,
          driver: "codex",
          availability: "unavailable",
          unavailableReason: "Driver 'codex' is not registered in this build.",
        });
      }),
    ),
  );

  it.effect("shadows invalid Pi config instead of constructing a partial runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalidId = ProviderInstanceId.make("pi_invalid");
        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [FakePiDriver],
          configMap: {
            [invalidId]: { driver: PI_DRIVER, config: { label: 42 } },
          } as ProviderInstanceConfigMap,
        });

        expect(yield* registry.listInstances).toEqual([]);
        expect(yield* registry.listUnavailable).toEqual([
          expect.objectContaining({
            instanceId: invalidId,
            driver: "pi",
            availability: "unavailable",
          }),
        ]);
      }),
    ),
  );
});
