/**
 * Per-environment terminal history.
 *
 * Read over HTTP, direct to each machine's own base URL, exactly like the
 * usage snapshot. Nothing here polls: a CLI session file that has already been
 * written does not change, and a background poll across four machines to
 * refresh a strip nobody is looking at is precisely the lag this feature is
 * supposed to avoid. Atoms are fetched when a strip mounts and cached for a
 * few minutes after it unmounts, so re-expanding a group is instant.
 *
 * **Old servers must not break the client.** The live machines run builds
 * without these routes, and that state ships for the minutes between rollout
 * steps, so every failure here resolves to `Option.none()` — read by the UI as
 * "this machine cannot serve history" — rather than surfacing as an error.
 *
 * Note what an old server actually returns, because it is not what you would
 * guess: the SPA catch-all (`GET "*"` in `apps/server/src/http.ts`) answers the
 * unknown route with **200 and an HTML page**, not a 404. Verified against a
 * live machine. So the failure arrives as a schema decode error, which is why
 * the catch here is `catchCause` over everything rather than a 404 tag check —
 * a tag check would have let the HTML through and broken the sidebar.
 *
 * @module ClientRuntimeTerminalHistory
 */
import type {
  EnvironmentId,
  HistorySessionId,
  HistorySessionsPage,
  HistoryTranscriptPage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { Atom } from "effect/unstable/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";
import { runInEnvironment } from "./runtime.ts";

/** Matches the usage and thread-snapshot fetches: one slow machine cannot stall the sidebar. */
const DEFAULT_HISTORY_TIMEOUT_MS = 6_000;

/**
 * How long a fetched page survives after its strip unmounts. Long enough that
 * collapsing and re-expanding a connection group is free.
 */
const HISTORY_IDLE_TTL_MS = 5 * 60_000;

/** Rows a strip asks for per page. */
export const HISTORY_STRIP_PAGE_SIZE = 12;

export interface HistorySessionsRequest {
  /**
   * ISO lower bound. Omitted means the server's default seven days; the empty
   * string explicitly opens the window to the whole index, which is what
   * "show older" sends once it has exhausted the default window.
   */
  readonly since?: string | undefined;
  /** ISO upper bound. Used to continue past a window the strip already covered. */
  readonly until?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const fetchEnvironmentHistorySessions = Effect.fn(
  "clientRuntime.state.fetchEnvironmentHistorySessions",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly request: HistorySessionsRequest;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/history/sessions");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.history.sessions({ headers, query: buildSessionsQuery(input.request) }),
    ),
  );
});

const buildSessionsQuery = (
  request: HistorySessionsRequest,
): { since?: string; until?: string; cursor?: string; limit?: string } => ({
  ...(request.since === undefined ? {} : { since: request.since }),
  ...(request.until === undefined ? {} : { until: request.until }),
  ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
});

export const fetchEnvironmentHistoryTranscript = Effect.fn(
  "clientRuntime.state.fetchEnvironmentHistoryTranscript",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly sessionId: HistorySessionId;
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
  readonly timeoutMs?: number;
}) {
  // Built by hand as well as templated by the client, because a relay
  // connection's DPoP proof binds to the fully interpolated URL. The two must
  // agree exactly.
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/history/sessions/${input.sessionId}/transcript`,
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
    input.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.history.transcript({
        headers,
        params: { sessionId: input.sessionId },
        query: {
          ...(input.before === undefined ? {} : { before: String(input.before) }),
          ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
        },
      }),
    ),
  );
});

export class TerminalHistoryLoader extends Context.Service<
  TerminalHistoryLoader,
  {
    readonly loadSessions: (input: {
      readonly prepared: PreparedConnection;
      readonly request: HistorySessionsRequest;
    }) => Effect.Effect<Option.Option<HistorySessionsPage>>;
    readonly loadTranscript: (input: {
      readonly prepared: PreparedConnection;
      readonly sessionId: HistorySessionId;
      readonly before?: number | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<Option.Option<HistoryTranscriptPage>>;
  }
>()("@t3tools/client-runtime/state/terminalHistory/TerminalHistoryLoader") {}

export const terminalHistoryLoaderLayer: Layer.Layer<
  TerminalHistoryLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  TerminalHistoryLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Optional for the same reason as the usage loader: only relay/DPoP
    // connections have a signer.
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);

    return TerminalHistoryLoader.of({
      loadSessions: (input) =>
        fetchEnvironmentHistorySessions({
          prepared: input.prepared,
          signer,
          request: input.request,
        }).pipe(
          Effect.map(Option.some<HistorySessionsPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            // Deliberately quiet and deliberately `none`. On a machine running
            // a build without the history routes this is a 404 on every
            // expand, and it must read as "unsupported", not as a failure.
            Effect.logDebug("Could not read terminal history over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<HistorySessionsPage>()),
            ),
          ),
        ),
      loadTranscript: (input) =>
        fetchEnvironmentHistoryTranscript({
          prepared: input.prepared,
          signer,
          sessionId: input.sessionId,
          before: input.before,
          limit: input.limit,
        }).pipe(
          Effect.map(Option.some<HistoryTranscriptPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logDebug("Could not read a terminal-history transcript over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<HistoryTranscriptPage>()),
            ),
          ),
        ),
    });
  }),
);

/**
 * Waits for the connection to be prepared before reading.
 *
 * Copied from the usage loader, and load-bearing for the same reason: this
 * atom can evaluate before the supervisor has finished preparing, and
 * returning "no history" then would leave the strip empty until something else
 * happened to re-run it. Passing tests and an empty panel in the app is
 * exactly the failure mode F3 flagged fork-wide.
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

/** Identifies one sessions page: an environment plus the window and cursor asked for. */
export interface HistorySessionsKey {
  readonly environmentId: EnvironmentId;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface HistoryTranscriptKey {
  readonly environmentId: EnvironmentId;
  readonly sessionId: HistorySessionId;
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
}

/**
 * `Atom.family` keys on identity, so a fresh object per render would leak a
 * new atom every time. Both families take a serialized string key and unpack
 * it, which is why these two functions exist rather than passing the record.
 */
export const historySessionsAtomKey = (key: HistorySessionsKey): string =>
  JSON.stringify([
    key.environmentId,
    key.since ?? null,
    key.until ?? null,
    key.cursor ?? null,
    key.limit ?? null,
  ]);

export const historyTranscriptAtomKey = (key: HistoryTranscriptKey): string =>
  JSON.stringify([key.environmentId, key.sessionId, key.before ?? null, key.limit ?? null]);

const parseSessionsKey = (serialized: string): HistorySessionsKey => {
  const [environmentId, since, until, cursor, limit] = JSON.parse(serialized) as [
    EnvironmentId,
    string | null,
    string | null,
    string | null,
    number | null,
  ];
  return {
    environmentId,
    ...(since === null ? {} : { since }),
    ...(until === null ? {} : { until }),
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null ? {} : { limit }),
  };
};

const parseTranscriptKey = (serialized: string): HistoryTranscriptKey => {
  const [environmentId, sessionId, before, limit] = JSON.parse(serialized) as [
    EnvironmentId,
    HistorySessionId,
    number | null,
    number | null,
  ];
  return {
    environmentId,
    sessionId,
    ...(before === null ? {} : { before }),
    ...(limit === null ? {} : { limit }),
  };
};

export function createEnvironmentTerminalHistoryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | TerminalHistoryLoader | R, E>,
) {
  const sessionsAtom = Atom.family((serializedKey: string) => {
    const key = parseSessionsKey(serializedKey);
    return runtime
      .atom(
        runInEnvironment(
          key.environmentId,
          withPreparedConnection((prepared) =>
            Effect.flatMap(TerminalHistoryLoader, (loader) =>
              loader.loadSessions({
                prepared,
                request: {
                  ...(key.since === undefined ? {} : { since: key.since }),
                  ...(key.until === undefined ? {} : { until: key.until }),
                  ...(key.cursor === undefined ? {} : { cursor: key.cursor }),
                  ...(key.limit === undefined ? {} : { limit: key.limit }),
                },
              }),
            ),
          ),
        ),
      )
      .pipe(
        // No `withRefresh`: an already-written session file does not change,
        // and a background poll is the lag this feature exists to avoid.
        Atom.setIdleTTL(HISTORY_IDLE_TTL_MS),
        Atom.withLabel(`environment-history-sessions:${serializedKey}`),
      );
  });

  const transcriptAtom = Atom.family((serializedKey: string) => {
    const key = parseTranscriptKey(serializedKey);
    return runtime
      .atom(
        runInEnvironment(
          key.environmentId,
          withPreparedConnection((prepared) =>
            Effect.flatMap(TerminalHistoryLoader, (loader) =>
              loader.loadTranscript({
                prepared,
                sessionId: key.sessionId,
                ...(key.before === undefined ? {} : { before: key.before }),
                ...(key.limit === undefined ? {} : { limit: key.limit }),
              }),
            ),
          ),
        ),
      )
      .pipe(
        Atom.setIdleTTL(HISTORY_IDLE_TTL_MS),
        Atom.withLabel(`environment-history-transcript:${serializedKey}`),
      );
  });

  return { sessionsAtom, transcriptAtom };
}
