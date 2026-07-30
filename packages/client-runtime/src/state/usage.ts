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
import type {
  CliUsageModelAlias,
  CliUsageModelAliasCatalog,
  EnvironmentId,
  EnvironmentUsageSnapshot,
} from "@starcode/contracts";
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
import { createEnvironmentCommand, runInEnvironment } from "./runtime.ts";

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
 * The machine's model-alias registry, plus the ids an alias may point at.
 *
 * A separate fetch from the snapshot rather than a field on it: it is edited a
 * handful of times in a machine's life and re-read only when the panel is
 * open, so paying for it on every 30-second poll would be waste.
 */
export const fetchEnvironmentUsageModelAliases = Effect.fn(
  "clientRuntime.state.fetchEnvironmentUsageModelAliases",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/usage/model-aliases");
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
      client.usage.modelAliases({ headers }),
    ),
  );
});

/**
 * Replaces the registry.
 *
 * The URL is interpolated by hand as well as templated for the same reason the
 * history routes do it: a relay connection's DPoP proof binds to the exact URL
 * the request is sent to.
 */
export const setEnvironmentUsageModelAliases = Effect.fn(
  "clientRuntime.state.setEnvironmentUsageModelAliases",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly aliases: ReadonlyArray<CliUsageModelAlias>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/usage/model-aliases");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "PUT",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_USAGE_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.usage.setModelAliases({ headers, payload: { aliases: input.aliases } }),
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
    /**
     * `None` means "this machine cannot tell us its aliases" — an old server,
     * or an unreachable one. The panel renders that as no assignment
     * affordance at all, never as "nothing is assigned", which would offer to
     * overwrite a mapping it could not read.
     */
    readonly loadModelAliases: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<CliUsageModelAliasCatalog>>;
    /** Answers with the stored registry, which is not always the requested one. */
    readonly setModelAliases: (input: {
      readonly prepared: PreparedConnection;
      readonly aliases: ReadonlyArray<CliUsageModelAlias>;
    }) => Effect.Effect<ModelAliasWriteAttempt>;
  }
>()("@starcode/client-runtime/state/usage/UsageSnapshotLoader") {}

/**
 * A write's two endings, both values.
 *
 * The failure is a value rather than an error channel because the panel has to
 * say what happened next to the row the user clicked, and an atom command's
 * error channel is not where a per-row message belongs.
 */
export type ModelAliasWriteAttempt =
  | { readonly kind: "saved"; readonly catalog: CliUsageModelAliasCatalog }
  | { readonly kind: "failed"; readonly message: string };

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
      loadModelAliases: (prepared: PreparedConnection) =>
        fetchEnvironmentUsageModelAliases({ prepared, signer }).pipe(
          Effect.map(Option.some<CliUsageModelAliasCatalog>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            // Quiet: a machine on a pre-F10.1 server answers this route with
            // the SPA's HTML and a 200, which fails to decode. That is
            // "unsupported", not a fault worth a warning.
            Effect.logDebug("Could not read the usage model aliases over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<CliUsageModelAliasCatalog>()),
            ),
          ),
        ),
      setModelAliases: (input) =>
        setEnvironmentUsageModelAliases({
          prepared: input.prepared,
          signer,
          aliases: input.aliases,
        }).pipe(
          Effect.map((catalog): ModelAliasWriteAttempt => ({ kind: "saved", catalog })),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // Loud, unlike the readers: this is a thing the user watched not
          // happen, and the panel has to say so beside the row they clicked.
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not save the usage model aliases.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as({
                kind: "failed",
                message: "This machine could not save the assignment.",
              } satisfies ModelAliasWriteAttempt),
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

/**
 * Waits for the connection the same way `loadUsageSnapshot` does, then hands it
 * to `use`. Pulled out because the alias reader and writer need the identical
 * "the supervisor may not have prepared yet" dance.
 */
const withPreparedConnection = <A, R>(
  use: (prepared: PreparedConnection) => Effect.Effect<A, never, R>,
): Effect.Effect<A, never, R | EnvironmentSupervisor> =>
  Effect.gen(function* () {
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
    return yield* use(prepared);
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

  /**
   * The alias registry. Not polled: it changes only when this client changes
   * it, and the write refreshes it explicitly.
   */
  const modelAliasesAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        runInEnvironment(
          environmentId,
          withPreparedConnection((prepared) =>
            Effect.flatMap(UsageSnapshotLoader, (loader) => loader.loadModelAliases(prepared)),
          ),
        ),
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-usage-model-aliases:${environmentId}`),
      ),
  );

  const modelAliasesValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): CliUsageModelAliasCatalog | null =>
      Option.getOrNull(Option.flatten(AsyncResult.value(get(modelAliasesAtom(environmentId))))),
    ).pipe(Atom.withLabel(`environment-usage-model-aliases-value:${environmentId}`)),
  );

  /**
   * The write. Serial per environment: two rows assigned in quick succession
   * each send the whole registry, so overlapping them would let the older
   * request's set win and silently drop the newer row.
   */
  const setModelAliasesCommand = createEnvironmentCommand(runtime, {
    label: "environment-usage:set-model-aliases",
    execute: (input: { readonly aliases: ReadonlyArray<CliUsageModelAlias> }) =>
      withPreparedConnection((prepared) =>
        Effect.flatMap(UsageSnapshotLoader, (loader) =>
          loader.setModelAliases({ prepared, aliases: input.aliases }),
        ),
      ),
    concurrency: {
      mode: "serial",
      key: ({ environmentId }) => environmentId,
    },
  });

  return {
    snapshotAtom,
    snapshotValueAtom,
    modelAliasesAtom,
    modelAliasesValueAtom,
    setModelAliasesCommand,
  };
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
