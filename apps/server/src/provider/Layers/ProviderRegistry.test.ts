import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  haveProvidersChanged,
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  ProviderRegistryLive,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");

const model = (
  slug: string,
  capabilities: ServerProviderModel["capabilities"],
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities,
});

const provider = (input: {
  readonly instanceId: string;
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly status?: ServerProvider["status"];
  readonly checkedAt?: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: PI_DRIVER,
  displayName: input.instanceId,
  continuation: { groupKey: `pi:instance:${input.instanceId}` },
  enabled: true,
  installed: true,
  version: "test",
  status: input.status ?? "ready",
  auth: { status: "authenticated" },
  checkedAt: input.checkedAt ?? "2026-08-04T00:00:00.000Z",
  models: input.models ?? [],
  slashCommands: [],
  skills: [],
});

const makePiInstance = (input: {
  readonly snapshot: ServerProvider;
  readonly refresh?: Effect.Effect<ServerProvider>;
  readonly streamChanges?: Stream.Stream<ServerProvider>;
}): ProviderInstance => ({
  instanceId: input.snapshot.instanceId,
  driverKind: PI_DRIVER,
  continuationIdentity: {
    driverKind: PI_DRIVER,
    continuationKey: `pi:instance:${input.snapshot.instanceId}`,
  },
  displayName: input.snapshot.displayName,
  enabled: input.snapshot.enabled,
  snapshot: {
    maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
      provider: PI_DRIVER,
      packageName: null,
    }),
    getSnapshot: Effect.succeed(input.snapshot),
    refresh: input.refresh ?? Effect.succeed(input.snapshot),
    streamChanges: input.streamChanges ?? Stream.empty,
  },
  adapter: {} as ProviderInstance["adapter"],
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const makeInstanceRegistryLayer = (
  instances: ReadonlyArray<ProviderInstance>,
  options?: {
    readonly changes?: PubSub.PubSub<void>;
    readonly listInstances?: Effect.Effect<ReadonlyArray<ProviderInstance>>;
  },
) =>
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
    listInstances: options?.listInstances ?? Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: options?.changes ? Stream.fromPubSub(options.changes) : Stream.empty,
    subscribeChanges: options?.changes
      ? PubSub.subscribe(options.changes)
      : Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  });

const makeRegistryLayer = (
  instanceRegistryLayer: Layer.Layer<ProviderInstanceRegistry.ProviderInstanceRegistry>,
  baseDir: string | { readonly prefix: string },
) =>
  ProviderRegistryLive.pipe(
    Layer.provideMerge(instanceRegistryLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

describe("ProviderRegistry Pi snapshots", () => {
  it("preserves known Pi model capabilities through a sparse refresh", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
      ],
    };
    const previous = provider({
      instanceId: "pi",
      models: [model("openai-codex/gpt-5.6-sol", capabilities)],
    });
    const refreshed = provider({
      instanceId: "pi",
      models: [model("openai-codex/gpt-5.6-sol", null)],
    });

    expect(mergeProviderSnapshot(previous, refreshed).models).toEqual([
      model("openai-codex/gpt-5.6-sol", capabilities),
    ]);
  });

  it("keeps the last authenticated Pi models when a transient refresh is empty", () => {
    const previous = provider({
      instanceId: "pi",
      models: [model("anthropic/claude-opus-5", { optionDescriptors: [] })],
    });
    const refreshed = provider({ instanceId: "pi", models: [], status: "warning" });

    expect(mergeProviderSnapshot(previous, refreshed)).toMatchObject({
      status: "warning",
      models: previous.models,
    });
  });

  it("merges snapshots by Pi instance id without cross-contaminating accounts", () => {
    const personal = provider({
      instanceId: "pi_personal",
      models: [model("openai-codex/gpt-5.6-sol", null)],
    });
    const work = provider({
      instanceId: "pi_work",
      models: [model("anthropic/claude-opus-5", null)],
    });
    const refreshedPersonal = provider({
      instanceId: "pi_personal",
      models: [model("anthropic/claude-fable-5", null)],
    });

    const merged = mergeProviderSnapshots([personal, work], [refreshedPersonal]);
    expect(merged.find((entry) => entry.instanceId === "pi_personal")?.models).toEqual([
      model("anthropic/claude-fable-5", null),
      model("openai-codex/gpt-5.6-sol", null),
    ]);
    expect(merged.find((entry) => entry.instanceId === "pi_work")?.models).toEqual(work.models);
  });

  it("selects Pi snapshots and detects material provider changes", () => {
    const snapshots = [provider({ instanceId: "pi" }), provider({ instanceId: "pi_work" })];
    expect(selectProvidersByKind(snapshots, new Set([PI_DRIVER]))).toEqual(snapshots);
    expect(haveProvidersChanged(snapshots, [...snapshots])).toBe(false);
    expect(
      haveProvidersChanged(snapshots, [snapshots[0]!, { ...snapshots[1]!, status: "warning" }]),
    ).toBe(true);
  });
});

it.layer(NodeServices.layer)("ProviderRegistryLive Pi lifecycle", (it) => {
  it.effect("hydrates the correlated Pi cache without running a provider refresh", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "starcode-provider-registry-cache-",
      });
      const cached = provider({
        instanceId: "pi",
        checkedAt: "2026-08-04T01:00:00.000Z",
        models: [model("openai-codex/gpt-5.6-sol", { optionDescriptors: [] })],
      });
      const pending = {
        ...provider({ instanceId: "pi", checkedAt: "2026-08-04T00:00:00.000Z" }),
        installed: false,
        version: null,
        status: "warning" as const,
        auth: { status: "unknown" as const },
      } satisfies ServerProvider;
      const refreshCalls = yield* Ref.make(0);
      const instance = makePiInstance({
        snapshot: pending,
        refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
      });
      const cachePath = yield* resolveProviderStatusCachePath({
        cacheDir: `${tempDir}/caches`,
        instanceId: cached.instanceId,
      });
      yield* writeProviderStatusCache({ filePath: cachePath, provider: cached });

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        expect(yield* registry.getProviders).toEqual([{ ...pending, models: cached.models }]);
        expect(yield* Ref.get(refreshCalls)).toBe(0);
      }).pipe(
        Effect.provide(
          yield* Layer.build(makeRegistryLayer(makeInstanceRegistryLayer([instance]), tempDir)),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("persists the merged Pi snapshot emitted by a live provider subscription", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const capabilities = {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [{ id: "high", label: "High", isDefault: true }],
            currentValue: "high",
          },
        ],
      };
      const initial = provider({
        instanceId: "pi",
        checkedAt: "2026-08-04T00:00:00.000Z",
        models: [model("openai-codex/gpt-5.6-sol", capabilities)],
      });
      const refreshed = provider({
        instanceId: "pi",
        checkedAt: "2026-08-04T00:01:00.000Z",
        status: "warning",
        models: [],
      });
      const instance = makePiInstance({
        snapshot: initial,
        streamChanges: Stream.fromPubSub(changes),
      });

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const config = yield* ServerConfig.ServerConfig;
        const cachePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: initial.instanceId,
        });

        yield* PubSub.publish(changes, refreshed);
        let cached = yield* readProviderStatusCache(cachePath);
        for (
          let attempt = 0;
          attempt < 50 && cached?.checkedAt !== refreshed.checkedAt;
          attempt++
        ) {
          yield* Effect.yieldNow;
          cached = yield* readProviderStatusCache(cachePath);
        }

        expect(cached).toEqual({ ...refreshed, models: initial.models });
        expect(yield* registry.getProviders).toEqual([{ ...refreshed, models: initial.models }]);
      }).pipe(
        Effect.provide(
          yield* Layer.build(
            makeRegistryLayer(makeInstanceRegistryLayer([instance]), {
              prefix: "starcode-provider-registry-persist-",
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("returns the last Pi snapshot when manual refresh fails", () =>
    Effect.gen(function* () {
      const cached = provider({ instanceId: "pi" });
      const instance = makePiInstance({
        snapshot: cached,
        refresh: Effect.die(new Error("simulated Pi refresh failure")),
      });

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        expect(yield* registry.refresh(PI_DRIVER)).toEqual([cached]);
        expect(yield* registry.refreshInstance(cached.instanceId)).toEqual([cached]);
        expect(yield* registry.getProviders).toEqual([cached]);
      }).pipe(
        Effect.provide(
          yield* Layer.build(
            makeRegistryLayer(makeInstanceRegistryLayer([instance]), {
              prefix: "starcode-provider-registry-refresh-failure-",
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps consuming Pi registry changes after one synchronization defect", () =>
    Effect.gen(function* () {
      const defaultSnapshot = provider({ instanceId: "pi" });
      const workSnapshot = provider({ instanceId: "pi_work" });
      const defaultInstance = makePiInstance({ snapshot: defaultSnapshot });
      const workInstance = makePiInstance({ snapshot: workSnapshot });
      const changes = yield* PubSub.unbounded<void>();
      const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([defaultInstance]);
      const failNextList = yield* Ref.make(false);
      const listInstances = Effect.gen(function* () {
        if (yield* Ref.get(failNextList)) {
          yield* Ref.set(failNextList, false);
          return yield* Effect.die(new Error("simulated Pi instance registry failure"));
        }
        return yield* Ref.get(instancesRef);
      });
      const instanceRegistryLayer = Layer.succeed(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        {
          getInstance: (instanceId) =>
            Ref.get(instancesRef).pipe(
              Effect.map((instances) =>
                instances.find((instance) => instance.instanceId === instanceId),
              ),
            ),
          listInstances,
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.fromPubSub(changes),
          subscribeChanges: PubSub.subscribe(changes),
        },
      );

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        expect(yield* registry.getProviders).toEqual([defaultSnapshot]);

        yield* Ref.set(failNextList, true);
        yield* PubSub.publish(changes, undefined);
        yield* Effect.yieldNow;

        yield* Ref.set(instancesRef, [defaultInstance, workInstance]);
        yield* PubSub.publish(changes, undefined);

        let providers = yield* registry.getProviders;
        for (
          let attempt = 0;
          attempt < 50 && !providers.some((entry) => entry.instanceId === workSnapshot.instanceId);
          attempt++
        ) {
          yield* Effect.yieldNow;
          providers = yield* registry.getProviders;
        }

        expect(providers.map((entry) => entry.instanceId)).toEqual(["pi", "pi_work"]);
      }).pipe(
        Effect.provide(
          yield* Layer.build(
            makeRegistryLayer(instanceRegistryLayer, {
              prefix: "starcode-provider-registry-sync-failure-",
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );
});
