import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { FleetClientBootstrapCache, layer } from "./FleetClientBootstrapCache.ts";

it.effect("invalidates a cached bootstrap snapshot immediately", () =>
  Effect.gen(function* () {
    const cache = yield* FleetClientBootstrapCache;
    yield* cache.put({
      authorityKey: "read",
      result: { revision: 4, nodes: [] },
      refreshAfterEpochMs: 10_000,
    });
    assert.isTrue(Option.isSome(yield* cache.get("read", 4, 1_000)));
    assert.isTrue(Option.isNone(yield* cache.get("standard", 4, 1_000)));
    yield* cache.invalidate;
    assert.isTrue(Option.isNone(yield* cache.get("read", 4, 1_000)));
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
