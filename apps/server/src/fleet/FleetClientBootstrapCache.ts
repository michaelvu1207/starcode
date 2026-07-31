/**
 * Short-lived process-memory cache for viewer bootstrap credentials.
 *
 * @module FleetClientBootstrapCache
 */
import type { FleetClientBootstrapResult } from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export interface FleetClientBootstrapCacheEntry {
  readonly authorityKey: string;
  readonly result: FleetClientBootstrapResult;
  readonly refreshAfterEpochMs: number;
}

export interface FleetClientBootstrapCacheShape {
  readonly get: (
    authorityKey: string,
    revision: number,
    nowEpochMs: number,
  ) => Effect.Effect<Option.Option<FleetClientBootstrapResult>>;
  readonly put: (entry: FleetClientBootstrapCacheEntry) => Effect.Effect<void>;
  readonly invalidate: Effect.Effect<void>;
}

export class FleetClientBootstrapCache extends Context.Service<
  FleetClientBootstrapCache,
  FleetClientBootstrapCacheShape
>()("starcode/fleet/FleetClientBootstrapCache") {}

export const make = Effect.gen(function* () {
  const state = yield* Ref.make<ReadonlyMap<string, FleetClientBootstrapCacheEntry>>(new Map());

  return FleetClientBootstrapCache.of({
    get: (authorityKey, revision, nowEpochMs) =>
      Ref.get(state).pipe(
        Effect.map((entries) => Option.fromUndefinedOr(entries.get(authorityKey))),
        Effect.map(Option.filter((entry) => entry.result.revision === revision)),
        Effect.map(Option.filter((entry) => entry.refreshAfterEpochMs > nowEpochMs)),
        Effect.map(Option.map((entry) => entry.result)),
      ),
    put: (entry) => Ref.update(state, (entries) => new Map(entries).set(entry.authorityKey, entry)),
    invalidate: Ref.set(state, new Map()),
  });
});

export const layer = Layer.effect(FleetClientBootstrapCache, make);
