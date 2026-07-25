/**
 * Per-environment project catalog: reads, and the writes the client fans out.
 *
 * Read over HTTP and polled, for the same reasons feature flow is — the record
 * is a JSON file outside the shell snapshot, and pushing it would mean a new WS
 * RPC method this fork does not add. A category is renamed by a human, so a
 * poll on the order of a minute is not visibly behind the truth.
 *
 * **Old servers must not break the view.** A machine on a build without
 * `/api/project-catalog` answers the SPA catch-all — **200 with an HTML page**,
 * not a 404 (verified live during F5, and again in F12). So absence arrives as
 * a schema decode failure, and the catch on every read here is `catchCause`
 * over everything rather than a status or tag check: a tag check would let the
 * HTML through. Every read failure resolves to `Option.none()`, which the fold
 * reads as "this machine contributes no categories", never as an error.
 *
 * **Writes do not get that treatment.** A write is a button a human pressed, and
 * the fan-out has to be able to say *which* machines took it — so each write
 * resolves to a tagged outcome rather than to `none`, and the caller reports
 * the machines that refused instead of silently diverging from them.
 *
 * @module ClientRuntimeProjectCatalog
 */
import type {
  EnvironmentId,
  ProjectCatalogFileThreadRequest,
  ProjectCatalogLocationsPage,
  ProjectCatalogSnapshot,
  ProjectCatalogUpsertRequest,
  ProjectCatalogUpsertResult,
  ProjectCategorySlug,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
  type EnvironmentHttpAuthHeaders,
} from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, runInEnvironment } from "./runtime.ts";

/** Reading a small JSON file. Nothing here shells out, unlike feature flow. */
const DEFAULT_PROJECT_CATALOG_TIMEOUT_MS = 8_000;

/**
 * A write is read-modify-write over one file behind a single-permit lock, so
 * the slow case is contention with another write, not the work itself.
 */
const DEFAULT_PROJECT_CATALOG_WRITE_TIMEOUT_MS = 12_000;

/**
 * Matches the feature-flow cadence deliberately: both panels are re-read for
 * the same reason (something a human did on another machine), and two different
 * poll intervals across the same four connections would be two different
 * answers to "how stale is this view".
 */
export const PROJECT_CATALOG_REFRESH_INTERVAL_MS = 45_000;

/** Locations change when a project is added — rarer than a category rename. */
export const PROJECT_CATALOG_LOCATIONS_REFRESH_INTERVAL_MS = 120_000;

export const fetchEnvironmentProjectCatalogSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentProjectCatalogSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/project-catalog");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_PROJECT_CATALOG_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.projectCatalog.snapshot({ headers }),
    ),
  );
});

export const fetchEnvironmentProjectCatalogLocations = Effect.fn(
  "clientRuntime.state.fetchEnvironmentProjectCatalogLocations",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/project-catalog/locations",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_PROJECT_CATALOG_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.projectCatalog.locations({ headers }),
    ),
  );
});

const writeRequest = <A, E, R>(input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly path: string;
  readonly timeoutMs?: number;
  readonly call: (headers: EnvironmentHttpAuthHeaders) => Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    // Interpolated by hand as well as templated: a relay connection's DPoP
    // proof binds to the exact URL, so the headers have to be built against the
    // same string the request is sent to.
    const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, input.path);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      input.signer,
    );
    // Deliberately not `executeEnvironmentHttpRequest`: that helper normalises
    // anything it does not recognise into a transport error, and here the
    // difference between "this server is too old" and "the network is down" is
    // the whole message the fan-out reports.
    return yield* withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      input.call(headers),
    ).pipe(
      Effect.timeoutOption(
        Duration.millis(input.timeoutMs ?? DEFAULT_PROJECT_CATALOG_WRITE_TIMEOUT_MS),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ProjectCatalogWriteTimeoutError({
                message: `The project-catalog write to ${requestUrl} timed out.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

/** The one failure this module mints itself: a write that never answered. */
export class ProjectCatalogWriteTimeoutError extends Schema.TaggedErrorClass<ProjectCatalogWriteTimeoutError>()(
  "ProjectCatalogWriteTimeoutError",
  { message: Schema.String },
) {}

/**
 * What one write against one machine produced.
 *
 * Three outcomes rather than a success/failure channel, because the fan-out
 * says something different about each: it worked, that machine's server predates
 * the catalog, or that machine could not be reached at all. Only the last is
 * worth retrying, and only the middle two are worth naming in the UI.
 */
export type ProjectCatalogWriteOutcome<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

const describeWriteFailure = (error: unknown): ProjectCatalogWriteOutcome<never> => {
  // A pre-catalog server answers the POST with the SPA's HTML and a 200, so
  // "the response did not parse" and "this server is too old" are the same
  // event — and only the second is a sentence worth showing.
  if (Schema.isSchemaError(error)) {
    return { kind: "unsupported", message: "This machine's server does not have projects yet." };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "ProjectCatalogWriteTimeoutError"
  ) {
    return { kind: "unavailable", message: "The machine did not answer in time." };
  }
  return { kind: "unavailable", message: "The machine could not be reached." };
};

export interface ProjectCatalogLoaderShape {
  readonly load: (
    prepared: PreparedConnection,
  ) => Effect.Effect<Option.Option<ProjectCatalogSnapshot>>;
  readonly loadLocations: (
    prepared: PreparedConnection,
  ) => Effect.Effect<Option.Option<ProjectCatalogLocationsPage>>;
  readonly upsert: (input: {
    readonly prepared: PreparedConnection;
    readonly request: ProjectCatalogUpsertRequest;
  }) => Effect.Effect<ProjectCatalogWriteOutcome<ProjectCatalogUpsertResult>>;
  readonly remove: (input: {
    readonly prepared: PreparedConnection;
    readonly slug: ProjectCategorySlug;
  }) => Effect.Effect<ProjectCatalogWriteOutcome<{ readonly removed: boolean }>>;
  readonly fileThread: (input: {
    readonly prepared: PreparedConnection;
    readonly request: ProjectCatalogFileThreadRequest;
  }) => Effect.Effect<ProjectCatalogWriteOutcome<ProjectCatalogSnapshot>>;
}

export class ProjectCatalogLoader extends Context.Service<
  ProjectCatalogLoader,
  ProjectCatalogLoaderShape
>()("@t3tools/client-runtime/state/projectCatalog/ProjectCatalogLoader") {}

export const projectCatalogLoaderLayer: Layer.Layer<
  ProjectCatalogLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ProjectCatalogLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Optional for the same reason as the usage loader: only relay/DPoP
    // connections have a signer.
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);

    const runWrite = <A>(
      effect: Effect.Effect<A, unknown, HttpClient.HttpClient>,
      logMessage: string,
    ): Effect.Effect<ProjectCatalogWriteOutcome<A>> =>
      effect.pipe(
        Effect.map((value): ProjectCatalogWriteOutcome<A> => ({ kind: "ok", value })),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catch((error) => Effect.succeed(describeWriteFailure(error))),
        // Defects land here. Unlike the readers this stays loud: a failed
        // write is a thing the operator watched not happen.
        Effect.catchCause((cause) =>
          Effect.logWarning(logMessage).pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as({
              kind: "unavailable",
              message: "The machine could not be reached.",
            } satisfies ProjectCatalogWriteOutcome<A>),
          ),
        ),
      );

    return ProjectCatalogLoader.of({
      load: (prepared) =>
        fetchEnvironmentProjectCatalogSnapshot({ prepared, signer }).pipe(
          Effect.map(Option.some<ProjectCatalogSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            // Deliberately quiet and deliberately `none`: on a machine without
            // the route this fires on every poll, and it must read as
            // "unsupported", not as a failure.
            Effect.logDebug("Could not load the project catalog over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<ProjectCatalogSnapshot>()),
            ),
          ),
        ),
      loadLocations: (prepared) =>
        fetchEnvironmentProjectCatalogLocations({ prepared, signer }).pipe(
          Effect.map(Option.some<ProjectCatalogLocationsPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logDebug("Could not load project-catalog locations over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<ProjectCatalogLocationsPage>()),
            ),
          ),
        ),
      upsert: (input) =>
        runWrite(
          Effect.gen(function* () {
            const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
            return yield* writeRequest({
              prepared: input.prepared,
              signer,
              path: "/api/project-catalog/upsert",
              call: (headers) => client.projectCatalog.upsert({ headers, payload: input.request }),
            });
          }),
          "A project-catalog upsert failed.",
        ),
      remove: (input) =>
        runWrite(
          Effect.gen(function* () {
            const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
            return yield* writeRequest({
              prepared: input.prepared,
              signer,
              path: "/api/project-catalog/remove",
              call: (headers) =>
                client.projectCatalog.remove({ headers, payload: { slug: input.slug } }),
            });
          }),
          "A project-catalog removal failed.",
        ),
      fileThread: (input) =>
        runWrite(
          Effect.gen(function* () {
            const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
            return yield* writeRequest({
              prepared: input.prepared,
              signer,
              path: "/api/project-catalog/file-thread",
              call: (headers) =>
                client.projectCatalog.fileThread({ headers, payload: input.request }),
            });
          }),
          "Filing a thread into a project failed.",
        ),
    });
  }),
);

/**
 * Waits for the connection to be prepared before reading.
 *
 * Load-bearing, and copied from the history loader for the same reason: this
 * atom can evaluate before the supervisor has finished preparing, and answering
 * "no categories" then would leave the projects view empty until something else
 * happened to re-run it.
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

export function createEnvironmentProjectCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ProjectCatalogLoader | R, E>,
  options?: {
    readonly refreshIntervalMs?: number;
    readonly locationsRefreshIntervalMs?: number;
  },
) {
  const refreshIntervalMs = options?.refreshIntervalMs ?? PROJECT_CATALOG_REFRESH_INTERVAL_MS;
  const locationsRefreshIntervalMs =
    options?.locationsRefreshIntervalMs ?? PROJECT_CATALOG_LOCATIONS_REFRESH_INTERVAL_MS;

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        runInEnvironment(
          environmentId,
          withPreparedConnection((prepared) =>
            Effect.flatMap(ProjectCatalogLoader, (loader) => loader.load(prepared)),
          ),
        ),
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withRefresh(refreshIntervalMs),
        Atom.withLabel(`environment-project-catalog:${environmentId}`),
      ),
  );

  /**
   * The snapshot with loading and failure collapsed to `null`. The view tells
   * the two apart by asking the catalog whether the machine is still pending,
   * exactly as the feature-flow panel does.
   */
  const snapshotValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ProjectCatalogSnapshot | null =>
      Option.getOrNull(Option.flatten(AsyncResult.value(get(snapshotAtom(environmentId))))),
    ).pipe(Atom.withLabel(`environment-project-catalog-value:${environmentId}`)),
  );

  const locationsAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        runInEnvironment(
          environmentId,
          withPreparedConnection((prepared) =>
            Effect.flatMap(ProjectCatalogLoader, (loader) => loader.loadLocations(prepared)),
          ),
        ),
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withRefresh(locationsRefreshIntervalMs),
        Atom.withLabel(`environment-project-catalog-locations:${environmentId}`),
      ),
  );

  const locationsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ProjectCatalogLocationsPage | null =>
      Option.getOrNull(Option.flatten(AsyncResult.value(get(locationsAtom(environmentId))))),
    ).pipe(Atom.withLabel(`environment-project-catalog-locations-value:${environmentId}`)),
  );

  /**
   * The writes.
   *
   * Serial per environment, which is what makes a fan-out safe to fire at four
   * machines at once: each machine's registry takes its writes one at a time
   * anyway, and queuing here means a rename and a bind issued together arrive
   * in the order the operator produced them rather than racing.
   */
  const upsertCommand = createEnvironmentCommand(runtime, {
    label: "environment-project-catalog:upsert",
    execute: (input: { readonly request: ProjectCatalogUpsertRequest }) =>
      withPreparedConnection((prepared) =>
        Effect.flatMap(ProjectCatalogLoader, (loader) =>
          loader.upsert({ prepared, request: input.request }),
        ),
      ),
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  });

  const removeCommand = createEnvironmentCommand(runtime, {
    label: "environment-project-catalog:remove",
    execute: (input: { readonly slug: ProjectCategorySlug }) =>
      withPreparedConnection((prepared) =>
        Effect.flatMap(ProjectCatalogLoader, (loader) =>
          loader.remove({ prepared, slug: input.slug }),
        ),
      ),
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  });

  const fileThreadCommand = createEnvironmentCommand(runtime, {
    label: "environment-project-catalog:file-thread",
    execute: (input: { readonly request: ProjectCatalogFileThreadRequest }) =>
      withPreparedConnection((prepared) =>
        Effect.flatMap(ProjectCatalogLoader, (loader) =>
          loader.fileThread({ prepared, request: input.request }),
        ),
      ),
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
  });

  return {
    snapshotAtom,
    snapshotValueAtom,
    locationsAtom,
    locationsValueAtom,
    upsertCommand,
    removeCommand,
    fileThreadCommand,
  };
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/**
 * Every connected environment's catalog in one map, mirroring the feature-flow
 * and usage fan-outs. Fanning out inside an atom rather than inside a component
 * keeps the subscription count free to change as machines connect and drop.
 */
export function createEnvironmentProjectCatalogSnapshotsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, unknown>;
  }>;
  readonly snapshotValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ProjectCatalogSnapshot | null>;
}) {
  let previous: ReadonlyMap<EnvironmentId, ProjectCatalogSnapshot> = new Map();
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ProjectCatalogSnapshot>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const snapshot = get(input.snapshotValueAtom(environmentId));
      if (snapshot !== null) next.set(environmentId, snapshot);
    }
    if (mapsEqual(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-project-catalog-snapshots"));
}

/** The same fan-out for bindable locations, which the seeding flow reads. */
export function createEnvironmentProjectCatalogLocationsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, unknown>;
  }>;
  readonly locationsValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ProjectCatalogLocationsPage | null>;
}) {
  let previous: ReadonlyMap<EnvironmentId, ProjectCatalogLocationsPage> = new Map();
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ProjectCatalogLocationsPage>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const page = get(input.locationsValueAtom(environmentId));
      if (page !== null) next.set(environmentId, page);
    }
    if (mapsEqual(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-project-catalog-locations"));
}
