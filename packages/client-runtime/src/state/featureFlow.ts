/**
 * Per-environment feature-flow state.
 *
 * Read over HTTP and polled, for the same reason usage is: the server computes
 * it from git, a computation that costs process spawns, and pushing it would
 * mean a new WS RPC method this fork does not add. Stage changes happen when a
 * human merges something, so a poll on the order of a minute is not visibly
 * behind the truth.
 *
 * **Old servers must not break the panel.** A machine on a build without
 * `/api/feature-flow` answers the SPA catch-all — **200 with an HTML page**, not
 * a 404 (verified live during F5). So absence arrives as a schema decode
 * failure, and the catch here is `catchCause` over everything rather than a
 * status or tag check: a tag check would let the HTML through. Every failure
 * resolves to `Option.none()`, read by the UI as "this machine cannot report
 * feature flow", never as an error.
 *
 * @module ClientRuntimeFeatureFlow
 */
import type { EnvironmentId, FeatureFlowSnapshot, FeatureMapSnapshot } from "@t3tools/contracts";
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

/**
 * Longer than the usage timeout: the server shells out to git once per project,
 * and a cold repository on a busy machine is slower than reading a table.
 */
const DEFAULT_FEATURE_FLOW_TIMEOUT_MS = 10_000;

/**
 * How often each connected environment is re-read. A feature changes stage when
 * a merge lands, which is a human-scale event — polling faster would spend git
 * on every machine to re-render the same lanes.
 */
export const FEATURE_FLOW_REFRESH_INTERVAL_MS = 45_000;

export const fetchEnvironmentFeatureFlowSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentFeatureFlowSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/feature-flow");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_FEATURE_FLOW_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.featureFlow.snapshot({ headers }),
    ),
  );
});

/**
 * Loads one environment's feature flow, returning `Option.none()` when it
 * cannot be read — including the mixed-fleet case where the machine's server
 * predates the route entirely.
 */
export class FeatureFlowSnapshotLoader extends Context.Service<
  FeatureFlowSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<FeatureFlowSnapshot>>;
  }
>()("@t3tools/client-runtime/state/featureFlow/FeatureFlowSnapshotLoader") {}

export const featureFlowSnapshotLoaderLayer: Layer.Layer<
  FeatureFlowSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  FeatureFlowSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Optional for the same reason as the usage loader: only relay/DPoP
    // connections have a signer.
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return FeatureFlowSnapshotLoader.of({
      load: (prepared: PreparedConnection) =>
        fetchEnvironmentFeatureFlowSnapshot({ prepared, signer }).pipe(
          Effect.map(Option.some<FeatureFlowSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            // Deliberately quiet and deliberately `none`: on a machine without
            // the route this fires on every poll, and it must read as
            // "unsupported", not as a failure.
            Effect.logDebug("Could not load the feature-flow snapshot over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<FeatureFlowSnapshot>()),
            ),
          ),
        ),
    });
  }),
);

const loadFeatureFlowSnapshot = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  // Waiting for the prepared connection rather than reporting "no flow" is the
  // difference between the panel filling in on open and staying empty until the
  // next poll — the fork-wide rule F3 flagged.
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
  const loader = yield* FeatureFlowSnapshotLoader;
  return yield* loader.load(prepared);
});

export function createEnvironmentFeatureFlowAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | FeatureFlowSnapshotLoader | R, E>,
  options?: { readonly refreshIntervalMs?: number },
) {
  const refreshIntervalMs = options?.refreshIntervalMs ?? FEATURE_FLOW_REFRESH_INTERVAL_MS;

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(runInEnvironment(environmentId, loadFeatureFlowSnapshot))
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withRefresh(refreshIntervalMs),
        Atom.withLabel(`environment-feature-flow:${environmentId}`),
      ),
  );

  /**
   * The snapshot with loading and failure collapsed to `null`. The panel
   * distinguishes the two by asking the catalog whether the machine is still
   * pending, exactly as the history strip does.
   */
  const snapshotValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): FeatureFlowSnapshot | null =>
      Option.getOrNull(
        Option.flatten(
          Option.map(AsyncResult.value(get(snapshotAtom(environmentId))), (snapshot) => snapshot),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-feature-flow-value:${environmentId}`)),
  );

  return { snapshotAtom, snapshotValueAtom };
}

const EMPTY_FEATURE_FLOW_SNAPSHOTS: ReadonlyMap<EnvironmentId, FeatureFlowSnapshot> = new Map();

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/**
 * Every connected environment's feature flow in one map, mirroring
 * `createEnvironmentUsageSnapshotsAtom`. Fanning out inside an atom rather than
 * inside a component keeps the subscription count free to change as machines
 * connect and disconnect.
 */
export function createEnvironmentFeatureFlowSnapshotsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, unknown>;
  }>;
  readonly snapshotValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<FeatureFlowSnapshot | null>;
}) {
  let previous = EMPTY_FEATURE_FLOW_SNAPSHOTS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, FeatureFlowSnapshot>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const snapshot = get(input.snapshotValueAtom(environmentId));
      if (snapshot !== null) next.set(environmentId, snapshot);
    }
    if (mapsEqual(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-feature-flow-snapshots"));
}

// ── The orchestrator's map ──────────────────────────────────────────
//
// The other half of the same answer, read from the same machines on the same
// poll and consumed by the same view, so it lives beside the derived flow
// rather than in a module of its own. Every degradation rule above applies
// unchanged: a server without the route answers the SPA catch-all with 200 and
// HTML, so absence arrives as a decode failure and resolves to `none`.

export const fetchEnvironmentFeatureMapSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentFeatureMapSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/feature-map");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    // A file read, not a git walk: the flow timeout would be generous here.
    input.timeoutMs ?? 5_000,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.featureFlow.map({ headers }),
    ),
  );
});

export class FeatureMapSnapshotLoader extends Context.Service<
  FeatureMapSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<FeatureMapSnapshot>>;
  }
>()("@t3tools/client-runtime/state/featureFlow/FeatureMapSnapshotLoader") {}

export const featureMapSnapshotLoaderLayer: Layer.Layer<
  FeatureMapSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  FeatureMapSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return FeatureMapSnapshotLoader.of({
      load: (prepared: PreparedConnection) =>
        fetchEnvironmentFeatureMapSnapshot({ prepared, signer }).pipe(
          Effect.map(Option.some<FeatureMapSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logDebug("Could not load the feature map over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<FeatureMapSnapshot>()),
            ),
          ),
        ),
    });
  }),
);

const loadFeatureMapSnapshot = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
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
  const loader = yield* FeatureMapSnapshotLoader;
  return yield* loader.load(prepared);
});

/**
 * Polled faster than the derived flow. The map changes when the orchestrator
 * acts — a tool call inside a turn the operator is watching — so a 45-second
 * lag would make its own writes look like they failed.
 */
export const FEATURE_MAP_REFRESH_INTERVAL_MS = 12_000;

export function createEnvironmentFeatureMapAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | FeatureMapSnapshotLoader | R, E>,
  options?: { readonly refreshIntervalMs?: number },
) {
  const refreshIntervalMs = options?.refreshIntervalMs ?? FEATURE_MAP_REFRESH_INTERVAL_MS;

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(runInEnvironment(environmentId, loadFeatureMapSnapshot))
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withRefresh(refreshIntervalMs),
        Atom.withLabel(`environment-feature-map:${environmentId}`),
      ),
  );

  const snapshotValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): FeatureMapSnapshot | null =>
      Option.getOrNull(
        Option.flatten(
          Option.map(AsyncResult.value(get(snapshotAtom(environmentId))), (snapshot) => snapshot),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-feature-map-value:${environmentId}`)),
  );

  return { snapshotAtom, snapshotValueAtom };
}

const EMPTY_FEATURE_MAP_SNAPSHOTS: ReadonlyMap<EnvironmentId, FeatureMapSnapshot> = new Map();

export function createEnvironmentFeatureMapSnapshotsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, unknown>;
  }>;
  readonly snapshotValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<FeatureMapSnapshot | null>;
}) {
  let previous = EMPTY_FEATURE_MAP_SNAPSHOTS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, FeatureMapSnapshot>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const snapshot = get(input.snapshotValueAtom(environmentId));
      if (snapshot !== null) next.set(environmentId, snapshot);
    }
    if (mapsEqual(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-feature-map-snapshots"));
}
