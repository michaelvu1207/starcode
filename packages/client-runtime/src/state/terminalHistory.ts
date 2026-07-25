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
import { HistoryImportRefusedError } from "@t3tools/contracts";
import type {
  EnvironmentId,
  HistoryImportNeedsProjectResult,
  HistoryImportRefusalReason,
  HistoryImportRequest,
  HistoryImportThreadResult,
  HistoryImportsPage,
  HistorySessionId,
  HistorySessionsPage,
  HistoryPreview,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import { createEnvironmentCommand, runInEnvironment } from "./runtime.ts";

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

export const fetchEnvironmentHistoryPreview = Effect.fn(
  "clientRuntime.state.fetchEnvironmentHistoryPreview",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly sessionId: HistorySessionId;
  readonly timeoutMs?: number;
}) {
  // Built by hand as well as templated by the client, because a relay
  // connection's DPoP proof binds to the fully interpolated URL. The two must
  // agree exactly.
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/history/sessions/${input.sessionId}/preview`,
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
      client.history.preview({
        headers,
        params: { sessionId: input.sessionId },
      }),
    ),
  );
});

export const fetchEnvironmentHistoryImports = Effect.fn(
  "clientRuntime.state.fetchEnvironmentHistoryImports",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/history/imports");
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
      client.history.imports({ headers }),
    ),
  );
});

/**
 * Importing is the one call here that must not be swallowed.
 *
 * Every other fetch in this module degrades silently to `Option.none()`,
 * because a machine that cannot list its history should read as "no history",
 * not as an error. An import is a button a human pressed: it either produced a
 * thread or it did not, and if it did not, the reason is the whole message.
 * The timeout is generous for the same reason — the server checks the session
 * against the provider's home, may create a project, creates a thread, and
 * writes the resume binding.
 */
const DEFAULT_HISTORY_IMPORT_TIMEOUT_MS = 20_000;

export const requestEnvironmentHistoryImport = Effect.fn(
  "clientRuntime.state.requestEnvironmentHistoryImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly sessionId: HistorySessionId;
  readonly request: HistoryImportRequest;
  readonly timeoutMs?: number;
}) {
  // Interpolated by hand as well as templated, for the same reason the preview
  // fetch is: a relay connection's DPoP proof binds to the exact URL.
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/history/sessions/${input.sessionId}/import`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  );
  // Deliberately NOT `executeEnvironmentHttpRequest`, which every other call
  // in this module uses. That helper normalises anything it does not
  // recognise into a transport error, and the 409 refusal — the one response
  // whose *contents* are the whole point — is exactly what it would not
  // recognise. So the timeout is applied here and the typed error channel is
  // left intact.
  return yield* withEnvironmentCredentials(
    input.prepared.httpAuthorization,
    client.history.import({
      headers,
      params: { sessionId: input.sessionId },
      payload: input.request,
    }),
  ).pipe(
    Effect.timeoutOption(Duration.millis(input.timeoutMs ?? DEFAULT_HISTORY_IMPORT_TIMEOUT_MS)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new HistoryImportTimeoutError({
              message: `The import request to ${requestUrl} timed out.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

/** The one failure this module mints itself: an import that never answered. */
export class HistoryImportTimeoutError extends Data.TaggedError("HistoryImportTimeoutError")<{
  readonly message: string;
}> {}

/**
 * What one press of "Resume in starcode" produced.
 *
 * A closed union rather than a success/failure channel, because all four
 * outcomes are things the dialog says out loud: it worked, it needs an answer
 * about a project first, it was refused for a stated reason, or the machine
 * could not be asked at all. Only the last is an error in any ordinary sense,
 * and even that one is a sentence rather than a stack trace.
 */
export type HistoryImportAttempt =
  | { readonly kind: "imported"; readonly result: HistoryImportThreadResult }
  | { readonly kind: "needsProject"; readonly result: HistoryImportNeedsProjectResult }
  | {
      readonly kind: "refused";
      readonly reason: HistoryImportRefusalReason;
      readonly detail: string | null;
    }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Turns whatever the import call failed with into something worth reading.
 *
 * The refusal is the case that matters — it carries which precondition failed
 * — and the rest collapse into one sentence each. The decode failure is worth
 * its own: on a machine still running a pre-import server the route answers
 * with the SPA's HTML and a 200, so "the response did not parse" and "this
 * server is too old" are the same event, and only the second is useful.
 */
const isHistoryImportRefusal = Schema.is(HistoryImportRefusedError);

const describeImportFailure = (error: unknown): HistoryImportAttempt => {
  if (isHistoryImportRefusal(error)) {
    return { kind: "refused", reason: error.reason, detail: error.detail ?? null };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "EnvironmentResourceNotFoundError"
  ) {
    return { kind: "unavailable", message: "That session is no longer on this machine." };
  }
  if (Schema.isSchemaError(error)) {
    return {
      kind: "unavailable",
      message: "This machine is running an older server that cannot import conversations yet.",
    };
  }
  const message =
    typeof error === "object" && error !== null && typeof (error as Error).message === "string"
      ? (error as Error).message
      : "The import failed.";
  return { kind: "unavailable", message };
};

export class TerminalHistoryLoader extends Context.Service<
  TerminalHistoryLoader,
  {
    readonly loadSessions: (input: {
      readonly prepared: PreparedConnection;
      readonly request: HistorySessionsRequest;
    }) => Effect.Effect<Option.Option<HistorySessionsPage>>;
    /**
     * One bounded read, with no cursor to page with. History is import-only:
     * this exists to tell two sessions apart, not to be scrolled.
     */
    readonly loadPreview: (input: {
      readonly prepared: PreparedConnection;
      readonly sessionId: HistorySessionId;
    }) => Effect.Effect<Option.Option<HistoryPreview>>;
    /**
     * Every import this machine has ever performed. Served whole, so the
     * picker can badge already-imported rows without a request per row, and
     * `None` on a machine whose server predates the route.
     */
    readonly loadImports: (input: {
      readonly prepared: PreparedConnection;
    }) => Effect.Effect<Option.Option<HistoryImportsPage>>;
    readonly importSession: (input: {
      readonly prepared: PreparedConnection;
      readonly sessionId: HistorySessionId;
      readonly request: HistoryImportRequest;
    }) => Effect.Effect<HistoryImportAttempt>;
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
      loadPreview: (input) =>
        fetchEnvironmentHistoryPreview({
          prepared: input.prepared,
          signer,
          sessionId: input.sessionId,
        }).pipe(
          Effect.map(Option.some<HistoryPreview>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            // Quiet and `none` for the same reason the sessions loader is: a
            // machine still on a pre-F12 build answers this route with 200 and
            // the SPA's HTML, which fails to decode. That must read as "no
            // preview", not as an error.
            Effect.logDebug("Could not read a terminal-history preview over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<HistoryPreview>()),
            ),
          ),
        ),
      loadImports: (input) =>
        fetchEnvironmentHistoryImports({ prepared: input.prepared, signer }).pipe(
          Effect.map(Option.some<HistoryImportsPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            // `None` here means "this machine cannot tell us what it has
            // imported", which the picker renders as no badges at all — never
            // as "nothing has been imported", which would offer to import a
            // session twice.
            Effect.logDebug("Could not read the terminal-history import registry over HTTP.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<HistoryImportsPage>()),
            ),
          ),
        ),
      importSession: (input) =>
        requestEnvironmentHistoryImport({
          prepared: input.prepared,
          signer,
          sessionId: input.sessionId,
          request: input.request,
        }).pipe(
          Effect.map(
            (result): HistoryImportAttempt =>
              result.status === "imported"
                ? { kind: "imported", result }
                : { kind: "needsProject", result },
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catch((error) => Effect.succeed(describeImportFailure(error))),
          // Defects land here. Unlike the readers this stays loud in the log —
          // a failed import is a thing the user watched not happen.
          Effect.catchCause((cause) =>
            Effect.logWarning("A terminal-history import failed.").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as({
                kind: "unavailable",
                message: "The machine could not be reached.",
              } satisfies HistoryImportAttempt),
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

export interface HistoryPreviewKey {
  readonly environmentId: EnvironmentId;
  readonly sessionId: HistorySessionId;
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

export const historyPreviewAtomKey = (key: HistoryPreviewKey): string =>
  JSON.stringify([key.environmentId, key.sessionId]);

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

const parsePreviewKey = (serialized: string): HistoryPreviewKey => {
  const [environmentId, sessionId] = JSON.parse(serialized) as [EnvironmentId, HistorySessionId];
  return { environmentId, sessionId };
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

  const previewAtom = Atom.family((serializedKey: string) => {
    const key = parsePreviewKey(serializedKey);
    return runtime
      .atom(
        runInEnvironment(
          key.environmentId,
          withPreparedConnection((prepared) =>
            Effect.flatMap(TerminalHistoryLoader, (loader) =>
              loader.loadPreview({ prepared, sessionId: key.sessionId }),
            ),
          ),
        ),
      )
      .pipe(
        Atom.setIdleTTL(HISTORY_IDLE_TTL_MS),
        Atom.withLabel(`environment-history-preview:${serializedKey}`),
      );
  });

  const importsAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        runInEnvironment(
          environmentId,
          withPreparedConnection((prepared) =>
            Effect.flatMap(TerminalHistoryLoader, (loader) => loader.loadImports({ prepared })),
          ),
        ),
      )
      .pipe(
        Atom.setIdleTTL(HISTORY_IDLE_TTL_MS),
        Atom.withLabel(`environment-history-imports:${environmentId}`),
      ),
  );

  /**
   * The import itself.
   *
   * A command rather than an atom because it writes, and because its result is
   * consumed once by the dialog that fired it rather than rendered from cache.
   * Serial per environment: double-clicking "Resume in starcode" must not race
   * two imports of the same session against each other, and the server's
   * idempotency is a backstop for that, not a licence to lean on it.
   */
  const importCommand = createEnvironmentCommand(runtime, {
    label: "environment-history:import",
    execute: (input: {
      readonly sessionId: HistorySessionId;
      readonly request: HistoryImportRequest;
    }) =>
      withPreparedConnection((prepared) =>
        Effect.flatMap(TerminalHistoryLoader, (loader) =>
          loader.importSession({
            prepared,
            sessionId: input.sessionId,
            request: input.request,
          }),
        ),
      ),
    concurrency: {
      mode: "serial",
      key: ({ environmentId }) => environmentId,
    },
  });

  return { sessionsAtom, previewAtom, importsAtom, importCommand };
}
