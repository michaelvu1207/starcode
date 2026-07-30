import { ProviderInstanceId, ThreadId } from "@starcode/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("starcode/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastUsedAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
}

/**
 * Idle eviction is off by default, because a session cannot recover from it.
 * The bearer is minted once and injected into the agent process at launch —
 * there is no re-mint path and nothing for the agent to refresh. So an idle
 * eviction is not "re-authenticate", it is permanent loss of every MCP tool
 * for the rest of that session, discovered only when a call fails. A coding
 * agent routinely goes half an hour writing code without touching MCP, which
 * made 30 minutes a near-certainty rather than an edge case.
 *
 * It also bought very little. The token sits in the process's argv, readable
 * by anything that can run `ps`; anyone reading it there can use it at once,
 * which refreshes `lastUsedAt` and defeats the idle window anyway. What
 * actually bounds exposure is the per-session capability scope, the
 * tailnet-scoped listener, and `revokeThread` on exit — none of which the idle
 * timer contributes to. Records live in an in-memory Map, so they die with the
 * process regardless.
 *
 * The absolute lifetime is off for exactly the same reason, and it took a
 * second round to see it: the argument above was written about the idle timer
 * while an eight-hour cap sat on the line below, doing the identical damage on
 * a slower clock. A thread whose provider session outlives the cap — an
 * overnight run, a long-lived orchestrator, anything the operator leaves
 * open — loses every MCP tool it has, permanently, with no error until a call
 * fails and no way for the agent to recover. `issue` is reached only from
 * `ProviderService.startSession`, so nothing re-mints until the session itself
 * restarts. That is not an expiry policy; it is a time bomb on long work.
 *
 * Both stay options, for a caller that genuinely wants either.
 */
const DEFAULT_IDLE_TIMEOUT_MS = Number.POSITIVE_INFINITY;
const DEFAULT_MAXIMUM_LIFETIME_MS = Number.POSITIVE_INFINITY;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  /**
   * A hard requirement, deliberately. This was briefly optional so the registry
   * could be built bare in tests, and the cost was severe: a layer that never
   * declares a dependency is never wired one, so `peers-operate` was withheld
   * from every session including the master — silently, with no error anywhere,
   * and the unit tests still passed because they provided the service directly.
   * Declaring it means a wiring mistake fails at build time instead of quietly
   * disabling the capability forever.
   */
  const settingsService = yield* ServerSettingsService;
  /**
   * Declared for the same reason `ServerSettingsService` is. Since F16 a
   * project can name its own orchestrator, so the catalog is now a source of
   * masters — and a layer that never declares it is a layer that is never wired
   * one, which is how the capability got silently withheld from every session
   * the first time.
   */
  const projectCatalogRegistry = yield* ProjectCatalogRegistry;

  const settingsMasterThreadIds: Effect.Effect<ReadonlyArray<string>> =
    settingsService.getSettings.pipe(
      Effect.map((settings) => [settings.workbenchMasterThreadId.trim()]),
      // A settings read that fails must not block a session from starting, so
      // it degrades to "no master" — which withholds the capability, the safe
      // direction, and says so in the log rather than silently.
      Effect.catchCause((cause) =>
        Effect.logWarning("could not resolve the workbench master thread; withholding operate", {
          cause,
        }).pipe(Effect.as([])),
      ),
    );

  const projectMasterThreadIds: Effect.Effect<ReadonlyArray<string>> =
    projectCatalogRegistry.list.pipe(
      Effect.map((categories) =>
        categories.map((category) => category.local.masterThreadId.trim()),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not resolve project master threads; withholding operate", {
          cause,
        }).pipe(Effect.as([])),
      ),
    );

  /**
   * Every thread this machine considers an orchestrator: the global
   * `/workbench` master from settings, plus the master each project names.
   *
   * A union rather than a replacement, because the two answer different
   * questions and both keep their answer — the global master orchestrates the
   * fleet, a project master orchestrates one project, and designating the
   * second must not silently demote the first.
   *
   * The two halves degrade **independently**. Folding them into one failure
   * channel would mean a corrupt catalog file taking the global master's tools
   * away, which is a much larger blast radius than the fault deserves; each
   * source contributes what it can read and logs what it cannot.
   */
  const resolveMasterThreadIds: Effect.Effect<ReadonlySet<string>> = Effect.map(
    Effect.all([settingsMasterThreadIds, projectMasterThreadIds], { concurrency: 2 }),
    ([fromSettings, fromProjects]) =>
      new Set([...fromSettings, ...fromProjects].filter((threadId) => threadId.length > 0)),
  );

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneExpired = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) =>
          timestamp <= record.scope.expiresAt && timestamp - record.lastUsedAt <= idleTimeoutMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      /**
       * `Infinity` is the honest in-memory value for "never", but it does not
       * survive `JSON.stringify` — it serializes to `null`, and this timestamp
       * is copied onto preview assignments that do cross a wire. Clamping to
       * the largest safe integer keeps the comparison it feeds (`timestamp <=
       * expiresAt`) true for the next quarter of a million years while staying
       * an ordinary number everywhere it is read.
       */
      const expiresAt =
        maximumLifetimeMs === Number.POSITIVE_INFINITY
          ? Number.MAX_SAFE_INTEGER
          : issuedAt + maximumLifetimeMs;
      // Read at mint time, not at layer construction, so re-designating a
      // master takes effect on the next session start rather than on the next
      // server restart.
      const masterThreadIds = yield* resolveMasterThreadIds;
      const isMaster = masterThreadIds.has(request.threadId);
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities: new Set<McpInvocationContext.McpCapability>(
          isMaster
            ? ["preview", "peers", "peers-operate", "features-operate"]
            : ["preview", "peers"],
        ),
        issuedAt,
        expiresAt,
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneExpired(records, issuedAt));
        next.set(tokenHash, { tokenHash, scope, lastUsedAt: issuedAt });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
        },
        expiresAt,
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(state, ({ records }) => {
        const current = pruneExpired(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) return [undefined, { records: current }] as const;
        const next = new Map(current);
        next.set(tokenHash, { ...record, lastUsedAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
