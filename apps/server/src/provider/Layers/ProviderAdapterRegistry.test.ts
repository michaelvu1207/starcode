import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@starcode/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistryLayer from "./ProviderAdapterRegistry.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");
const piInstanceId = defaultInstanceIdForDriver(PI_DRIVER);

const fakePiAdapter: ProviderInstance["adapter"] = {
  provider: PI_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakePiInstance: ProviderInstance = {
  instanceId: piInstanceId,
  driverKind: PI_DRIVER,
  continuationIdentity: {
    driverKind: PI_DRIVER,
    continuationKey: "pi:instance:pi",
  },
  displayName: undefined,
  enabled: true,
  snapshot: {
    maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
      provider: PI_DRIVER,
      packageName: null,
    }),
    getSnapshot: Effect.succeed({} as ServerProvider),
    refresh: Effect.succeed({} as ServerProvider),
    streamChanges: Stream.empty,
  },
  adapter: fakePiAdapter,
  textGeneration: {} as TextGeneration.TextGeneration["Service"],
};

const fakeInstanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === piInstanceId ? fakePiInstance : undefined),
  listInstances: Effect.succeed([fakePiInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
});

const layer = ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive.pipe(
  Layer.provide(fakeInstanceRegistryLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("ProviderAdapterRegistryLive", (it) => {
  it("resolves the sole Pi adapter and routing metadata", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;

      assert.strictEqual(yield* registry.getByInstance(piInstanceId), fakePiAdapter);
      assert.deepStrictEqual(yield* registry.getInstanceInfo(piInstanceId), {
        instanceId: piInstanceId,
        driverKind: PI_DRIVER,
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: PI_DRIVER,
          continuationKey: "pi:instance:pi",
        },
      });
      assert.deepStrictEqual(yield* registry.listInstances(), [piInstanceId]);
      assert.deepStrictEqual(yield* registry.listProviders(), [PI_DRIVER]);
    }));

  it("does not remap a removed harness instance to Pi", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const result = yield* Effect.result(registry.getByInstance(ProviderInstanceId.make("codex")));

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.failure), /Provider 'codex' is not implemented/);
      }
    }));
});
