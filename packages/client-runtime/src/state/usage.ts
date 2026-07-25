/**
 * Per-environment usage state.
 *
 * Read over HTTP and polled, not streamed. A live push would require a new WS
 * RPC method, and this fork keeps the RPC group untouched (see
 * `apps/server/src/usage/http.ts`). The data justifies it: rate-limit windows
 * move on the order of minutes and spend is a monotonic running total, so the
 * only thing polling costs is immediacy.
 *
 * @module ClientRuntimeUsage
 */
import type { EnvironmentId, EnvironmentUsageSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";
import { runInEnvironment } from "./runtime.ts";

/** Matches the thread-snapshot fetch: bounded so one slow machine cannot stall the panel. */
const DEFAULT_USAGE_SNAPSHOT_TIMEOUT_MS = 6_000;

/**
 * How often each connected environment is re-read. Claude only re-probes its
 * own account every five minutes, so a faster poll would mostly re-render
 * identical data.
 */
export const USAGE_REFRESH_INTERVAL_MS = 30_000;

export const fetchEnvironmentUsageSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentUsageSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/usage/snapshot");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_USAGE_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.usage.snapshot({ headers }),
    ),
  );
});

/**
 * Loads one environment's usage, returning `Option.none()` when it cannot be
 * read. A machine running a server without the usage routes answers 404, which
 * is a normal state in a mixed fleet, not an error — the panel renders that row
 * as "no usage data" rather than as a failure.
 */
export class UsageSnapshotLoader extends Context.Service<
  UsageSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<EnvironmentUsageSnapshot>>;
  }
>()("@t3tools/client-runtime/state/usage/UsageSnapshotLoader") {}

export const usageSnapshotLoaderLayer: Layer.Layer<
  UsageSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  UsageSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Optional for the same reason as the thread-snapshot loader: only
    // relay/DPoP connections have a signer.
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return UsageSnapshotLoader.of({
      load: (prepared: PreparedConnection) =>
        fetchEnvironmentUsageSnapshot({ prepared, signer }).pipe(
          Effect.map(Option.some<EnvironmentUsageSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logDebug("Could not load the usage snapshot over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<EnvironmentUsageSnapshot>()),
            ),
          ),
        ),
    });
  }),
);

const loadUsageSnapshot = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  // The connection is prepared asynchronously, and this atom can evaluate
  // first. Waiting for it — rather than reporting "no usage" and relying on a
  // later poll — matches how the thread and shell snapshot loaders read it,
  // and is the difference between the panel filling in on open and staying
  // empty until the next refresh.
  const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          SubscriptionRef.changes(supervisor.prepared).pipe(
            Stream.filter(Option.isSome),
            Stream.map((value) => value.value),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
      }),
    ),
  );
  const loader = yield* UsageSnapshotLoader;
  return yield* loader.load(prepared);
});

export function createEnvironmentUsageAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | UsageSnapshotLoader | R, E>,
  options?: { readonly refreshIntervalMs?: number },
) {
  const refreshIntervalMs = options?.refreshIntervalMs ?? USAGE_REFRESH_INTERVAL_MS;

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(runInEnvironment(environmentId, loadUsageSnapshot))
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withRefresh(refreshIntervalMs),
        Atom.withLabel(`environment-usage:${environmentId}`),
      ),
  );

  /**
   * The snapshot with loading and failure collapsed to `null`. The panel keeps
   * rendering account identity from the server config either way, so a usage
   * read that has not landed yet is a missing number, not a missing row.
   */
  const snapshotValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): EnvironmentUsageSnapshot | null =>
      Option.getOrNull(
        Option.flatten(
          Option.map(AsyncResult.value(get(snapshotAtom(environmentId))), (snapshot) => snapshot),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-usage-value:${environmentId}`)),
  );

  return { snapshotAtom, snapshotValueAtom };
}

const EMPTY_USAGE_SNAPSHOTS: ReadonlyMap<EnvironmentId, EnvironmentUsageSnapshot> = new Map();

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/**
 * Every connected environment's usage in one map, mirroring
 * `createEnvironmentServerConfigsAtom`. Fanning out inside an atom rather than
 * inside a component is what keeps the number of subscriptions free to change
 * as machines connect and disconnect.
 */
export function createEnvironmentUsageSnapshotsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, unknown>;
  }>;
  readonly snapshotValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentUsageSnapshot | null>;
}) {
  let previous = EMPTY_USAGE_SNAPSHOTS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentUsageSnapshot>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const snapshot = get(input.snapshotValueAtom(environmentId));
      if (snapshot !== null) next.set(environmentId, snapshot);
    }
    if (mapsEqual(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-usage-snapshots"));
}
