/**
 * Fleet registration and reconciliation coordinator.
 *
 * One explicit pairing establishes an administrative node session, exchanges
 * complete rosters, installs the reciprocal credential, and returns short-lived
 * introductions for transitive members. Reconciliation repeats until no new
 * credential-bearing member is discovered (bounded to three passes).
 *
 * @module FleetReconciler
 */
import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type FleetClientBootstrapNode,
  type FleetClientBootstrapResult,
  type FleetExchangeInput,
  type FleetExchangeResult,
  type FleetIntroduction,
  type FleetMember,
  type FleetNode,
  type FleetReconcileFailureReason,
  type FleetReconcileResult,
  type FleetRegisterInput,
  type FleetRegisterResult,
  type FleetRoster,
  type FleetThreadIndexEntry,
  type FleetThreadIndexFailure,
  resolveLocalProjectMembership,
} from "@starcode/contracts";
import { createAdvertisedEndpoint } from "@starcode/shared/advertisedEndpoint";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  peerProjectByThread,
  peerThreadLastActivityAt,
  resolvePeerThreadStatus,
} from "../peers/transcript.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";
import {
  exchangeFleetPairingToken,
  exchangeFleetRoster,
  fetchFleetDescriptor,
  fetchFleetProjectCatalog,
  fetchFleetSessionState,
  fetchFleetShellSnapshot,
  fetchFleetSnapshot,
  mintRemoteFleetPairingCredential,
  mintRemoteStandardClientAccess,
} from "./FleetClient.ts";
import { FleetClientBootstrapCache } from "./FleetClientBootstrapCache.ts";
import { FleetRegistry, type ResolvedFleetMember } from "./FleetRegistry.ts";
import { mergeFleetRosters } from "./FleetRoster.ts";
import { FleetThreadIndex } from "./FleetThreadIndex.ts";

export const FleetRegistrationFailureReason = Schema.Literals([
  "invalid_base_url",
  "duplicate_name",
  "exchange_rejected",
  "token_rejected",
  "node_unreachable",
  "administrative_scope_required",
]);
export type FleetRegistrationFailureReason = typeof FleetRegistrationFailureReason.Type;

export class FleetRegistrationError extends Schema.TaggedErrorClass<FleetRegistrationError>()(
  "FleetRegistrationError",
  {
    reason: FleetRegistrationFailureReason,
    name: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Could not register fleet node ${this.name}: ${this.reason}.`;
  }
}

export const isFleetRegistrationError = Schema.is(FleetRegistrationError);

export const FLEET_CLIENT_BOOTSTRAP_REMOTE_TIMEOUT = Duration.seconds(2);

/**
 * Resolve remote viewer credentials in parallel without letting an offline
 * fleet member delay the local client's bootstrap. Remote nodes are optional:
 * the next one-minute discovery poll can add any member that misses this
 * deliberately short startup budget.
 */
export const collectAvailableFleetBootstrapNodes = Effect.fn(
  "FleetReconciler.collectAvailableFleetBootstrapNodes",
)(function* (
  candidates: ReadonlyArray<Effect.Effect<Option.Option<FleetClientBootstrapNode>, never>>,
  timeout: Duration.Input = FLEET_CLIENT_BOOTSTRAP_REMOTE_TIMEOUT,
) {
  const resolved = yield* Effect.forEach(
    candidates,
    (candidate) =>
      candidate.pipe(
        Effect.timeout(timeout),
        Effect.catchCause(() => Effect.succeed(Option.none<FleetClientBootstrapNode>())),
      ),
    { concurrency: "unbounded" },
  );
  return resolved.flatMap((node) => (Option.isSome(node) ? [node.value] : []));
});

export function fleetRegistrationFailureDetail(
  reason: "node_unreachable" | "exchange_rejected",
): string;
export function fleetRegistrationFailureDetail(
  reason: FleetRegistrationFailureReason,
): string | undefined;
export function fleetRegistrationFailureDetail(
  reason: FleetRegistrationFailureReason,
): string | undefined {
  switch (reason) {
    case "node_unreachable":
      return "The target node could not be reached.";
    case "exchange_rejected":
      return "The pairing exchange was rejected.";
    case "invalid_base_url":
    case "duplicate_name":
    case "token_rejected":
    case "administrative_scope_required":
      return undefined;
  }
}

export class FleetOperationError extends Schema.TaggedErrorClass<FleetOperationError>()(
  "FleetOperationError",
  {
    operation: Schema.Literals(["register", "reconcile", "exchange", "bootstrap", "self"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Fleet ${this.operation} failed.`;
  }
}

const normalizeBaseUrl = (value: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
};

const defaultBaseUrl = (config: ServerConfig.ServerConfig["Service"]): string => {
  const host =
    config.host === undefined || config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
};

export const deriveFleetNodeName = (label: string, environmentId: EnvironmentId): string => {
  const labelSlug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const idSuffix =
    environmentId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(-8) || "node";
  const prefix = (labelSlug || "node").slice(0, Math.max(1, 55 - idSuffix.length));
  return `${prefix}-${idSuffix}`;
};

export const resolveSelfBaseUrl = (input: {
  readonly explicit?: string;
  readonly existing?: string;
  readonly fallback: string;
}): string =>
  normalizeBaseUrl(input.explicit ?? "") ??
  normalizeBaseUrl(input.existing ?? "") ??
  input.fallback;

const endpointFor = (baseUrl: string, label: string) =>
  createAdvertisedEndpoint({
    id: "fleet-default",
    label,
    provider: {
      id: "fleet",
      label: "StarCode fleet",
      kind: "private-network",
      isAddon: false,
    },
    httpBaseUrl: baseUrl,
    reachability: "private-network",
    source: "server",
    isDefault: true,
  });

const preferredEndpoint = (member: FleetMember) =>
  member.node.endpoints.find((endpoint) => endpoint.isDefault === true) ?? member.node.endpoints[0];

const hasAdministrativeScopes = (scopes: ReadonlyArray<string>): boolean =>
  AuthAdministrativeScopes.every((scope) => scopes.includes(scope));

export const fleetRosterRecordsEqual = (left: FleetRoster, right: FleetRoster): boolean =>
  Equal.equals(left.members, right.members) && Equal.equals(left.tombstones, right.tombstones);

export const fleetRosterRequiresExchange = (local: FleetRoster, remote: FleetRoster): boolean =>
  !fleetRosterRecordsEqual(remote, mergeFleetRosters(remote, local));

/**
 * A newly contacted node may learn its own loopback fallback a few
 * milliseconds after the registering node records the reachable address.
 * Reassert the observed registration metadata after the first reconciliation
 * so last-writer-wins convergence keeps the endpoint that actually worked.
 */
export const reassertRegisteredFleetMember = (
  member: FleetMember,
  updatedAt: string,
): FleetMember => ({
  ...member,
  node: {
    ...member.node,
    updatedAt,
  },
  updatedAt,
});

export const nextFleetRegistrationTimestamp = (
  now: string,
  observedTimestamps: ReadonlyArray<string>,
): string => {
  const observedEpochMs = observedTimestamps.map(
    (timestamp) => DateTime.makeUnsafe(timestamp).epochMilliseconds,
  );
  const latestObservedEpochMs =
    observedEpochMs.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...observedEpochMs);
  return DateTime.formatIso(
    DateTime.makeUnsafe(
      Math.max(DateTime.makeUnsafe(now).epochMilliseconds, latestObservedEpochMs + 1),
    ),
  );
};

/**
 * Viewer credentials can never gain authority through fleet discovery.
 * Administrative-only scopes are omitted and every retained client scope must
 * already exist on the authenticated anchor session.
 */
export const deriveFleetClientScopes = (
  anchorScopes: Iterable<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> => {
  const granted = new Set(anchorScopes);
  return AuthStandardClientScopes.filter((scope) => granted.has(scope));
};

interface ResolvedRegistrationCredential {
  readonly credential: string;
}

export interface FleetReconcilerShape {
  readonly register: (
    input: FleetRegisterInput,
  ) => Effect.Effect<FleetRegisterResult, FleetRegistrationError | FleetOperationError>;
  readonly reconcile: Effect.Effect<FleetReconcileResult, FleetOperationError>;
  readonly exchange: (
    input: FleetExchangeInput,
  ) => Effect.Effect<FleetExchangeResult, FleetOperationError>;
  readonly clientBootstrap: (
    anchorScopes: Iterable<AuthEnvironmentScope>,
  ) => Effect.Effect<FleetClientBootstrapResult, FleetOperationError>;
  readonly ensureSelf: (baseUrl?: string) => Effect.Effect<FleetMember, FleetOperationError>;
  readonly remove: (
    environmentId: EnvironmentId,
    now: string,
  ) => Effect.Effect<
    { readonly removed: boolean; readonly roster: FleetRoster },
    FleetOperationError
  >;
}

export class FleetReconciler extends Context.Service<FleetReconciler, FleetReconcilerShape>()(
  "starcode/fleet/FleetReconciler",
) {}

export const make = Effect.gen(function* () {
  const registry = yield* FleetRegistry;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectCatalog = yield* ProjectCatalogRegistry;
  const threadIndex = yield* FleetThreadIndex;
  const clientBootstrapCache = yield* FleetClientBootstrapCache;
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;

  const ensureSelfInternal = Effect.fn("FleetReconciler.ensureSelfInternal")(function* (
    baseUrlOverride: string | undefined,
  ) {
    const descriptor = yield* serverEnvironment.getDescriptor;
    const now = DateTime.formatIso(yield* DateTime.now);
    const roster = yield* registry.snapshot;
    const existing = roster.members.find(
      (candidate) => candidate.node.environmentId === descriptor.environmentId,
    );
    const existingEndpoint = existing === undefined ? undefined : preferredEndpoint(existing);
    const baseUrl = resolveSelfBaseUrl({
      ...(baseUrlOverride === undefined ? {} : { explicit: baseUrlOverride }),
      ...(existingEndpoint === undefined ? {} : { existing: existingEndpoint.httpBaseUrl }),
      fallback: defaultBaseUrl(config),
    });
    const endpoint = endpointFor(baseUrl, descriptor.label);
    const name =
      existing?.node.name ?? deriveFleetNodeName(descriptor.label, descriptor.environmentId);
    if (
      existing !== undefined &&
      existing.node.label === descriptor.label &&
      existing.node.platform.os === descriptor.platform.os &&
      existing.node.platform.arch === descriptor.platform.arch &&
      existingEndpoint?.httpBaseUrl === endpoint.httpBaseUrl &&
      existingEndpoint.wsBaseUrl === endpoint.wsBaseUrl
    ) {
      return existing;
    }
    const node: FleetNode = {
      environmentId: descriptor.environmentId,
      name,
      label: descriptor.label,
      platform: descriptor.platform,
      endpoints: [endpoint],
      sshUser: existing?.node.sshUser ?? null,
      updatedAt: now,
    };
    const member: FleetMember = {
      node,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    yield* registry.upsert(member);
    yield* clientBootstrapCache.invalidate;
    return member;
  });
  const ensureSelf: FleetReconcilerShape["ensureSelf"] = (baseUrl) =>
    ensureSelfInternal(baseUrl).pipe(
      Effect.mapError((cause) => new FleetOperationError({ operation: "self", cause })),
    );

  const resolveRegistrationCredential = Effect.fn("FleetReconciler.resolveRegistrationCredential")(
    function* (
      baseUrl: string,
      input: FleetRegisterInput,
    ): Effect.fn.Return<ResolvedRegistrationCredential, FleetRegistrationError> {
      if ("token" in input.credential) {
        const state = yield* fetchFleetSessionState({
          baseUrl,
          credential: input.credential.token,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            () =>
              new FleetRegistrationError({
                reason: "node_unreachable",
                name: input.name,
                detail: fleetRegistrationFailureDetail("node_unreachable"),
              }),
          ),
        );
        if (!state.authenticated) {
          return yield* new FleetRegistrationError({
            reason: "token_rejected",
            name: input.name,
          });
        }
        if (!hasAdministrativeScopes(state.scopes ?? [])) {
          return yield* new FleetRegistrationError({
            reason: "administrative_scope_required",
            name: input.name,
          });
        }
        return { credential: input.credential.token };
      }

      const exchanged = yield* exchangeFleetPairingToken({
        baseUrl,
        pairingToken: input.credential.pairingToken,
        label: `StarCode fleet node ${input.name}`,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError(
          () =>
            new FleetRegistrationError({
              reason: "exchange_rejected",
              name: input.name,
              detail: fleetRegistrationFailureDetail("exchange_rejected"),
            }),
        ),
      );
      return { credential: exchanged.access_token };
    },
  );

  const consumeIntroduction = Effect.fn("FleetReconciler.consumeIntroduction")(function* (
    introduction: FleetIntroduction,
  ) {
    const existing = yield* registry.resolveByEnvironmentId(introduction.node.environmentId);
    if (Option.isSome(existing)) return;
    const endpoint =
      introduction.node.endpoints.find((candidate) => candidate.isDefault) ??
      introduction.node.endpoints[0];
    if (endpoint === undefined) return;
    const exchanged = yield* exchangeFleetPairingToken({
      baseUrl: endpoint.httpBaseUrl,
      pairingToken: introduction.pairingToken,
      label: `StarCode transitive fleet node ${introduction.node.name}`,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    yield* registry.upsert(
      {
        node: introduction.node,
        registeredAt: introduction.node.updatedAt,
        updatedAt: introduction.node.updatedAt,
      },
      exchanged.access_token,
    );
    yield* clientBootstrapCache.invalidate;
  });

  const revokeTombstonedSessions = Effect.fn("FleetReconciler.revokeTombstonedSessions")(
    function* () {
      const roster = yield* registry.snapshot;
      const removed = new Set(roster.tombstones.map((entry) => entry.environmentId));
      if (removed.size === 0) return;
      const sessions = yield* auth.listSessions();
      const revokedSessions = sessions.filter(
        (session) =>
          session.subject.startsWith("fleet-node:") &&
          removed.has(EnvironmentId.make(session.subject.slice("fleet-node:".length))),
      );
      yield* Effect.forEach(revokedSessions, (session) => auth.revokeSession(session.sessionId), {
        concurrency: 4,
        discard: true,
      });
      if (revokedSessions.length > 0) yield* clientBootstrapCache.invalidate;
    },
  );

  const indexEntries = (
    member: FleetMember,
    threads: ReadonlyArray<{
      readonly id: FleetThreadIndexEntry["threadId"];
      readonly title: string;
      readonly updatedAt: string;
      readonly createdAt: string;
      readonly latestUserMessageAt: string | null;
      readonly latestTurn: Parameters<typeof peerThreadLastActivityAt>[0]["latestTurn"];
      readonly session: Parameters<typeof peerThreadLastActivityAt>[0]["session"];
      readonly archivedAt: string | null;
      readonly hasPendingApprovals: boolean;
      readonly hasPendingUserInput: boolean;
      readonly modelSelection: {
        readonly instanceId: string;
        readonly model: string;
      };
      readonly branch: string | null;
      readonly planSummary?: FleetThreadIndexEntry["planSummary"];
    }>,
    projectByThread: ReadonlyMap<
      FleetThreadIndexEntry["threadId"],
      FleetThreadIndexEntry["project"]
    >,
  ): ReadonlyArray<FleetThreadIndexEntry> =>
    threads.map((thread) => ({
      threadId: thread.id,
      node: member.node.environmentId,
      nodeName: member.node.name,
      project: projectByThread.get(thread.id) ?? null,
      title: thread.title,
      status: resolvePeerThreadStatus(thread),
      lastActivityAt: peerThreadLastActivityAt(thread),
      createdAt: thread.createdAt,
      provider: thread.session?.providerName ?? thread.modelSelection.instanceId ?? null,
      model: thread.modelSelection.model ?? null,
      branch: thread.branch,
      ...(thread.planSummary === undefined ? {} : { planSummary: thread.planSummary }),
    }));

  const refreshThreadIndex = Effect.fn("FleetReconciler.refreshThreadIndex")(function* () {
    const self = yield* ensureSelfInternal(undefined);
    const localEntries = yield* Effect.all({
      snapshot: projectionSnapshotQuery.getShellSnapshot(),
      categories: projectCatalog.list,
    }).pipe(
      Effect.map(({ snapshot, categories }) => {
        const bySlug = resolveLocalProjectMembership({
          categories,
          threads: snapshot.threads.map((thread) => ({
            id: thread.id,
            projectId: thread.projectId,
          })),
        });
        const byThread = new Map<
          FleetThreadIndexEntry["threadId"],
          FleetThreadIndexEntry["project"]
        >();
        for (const [slug, threadIds] of bySlug) {
          for (const threadId of threadIds)
            if (!byThread.has(threadId)) byThread.set(threadId, slug);
        }
        return indexEntries(self, snapshot.threads, byThread);
      }),
      Effect.orElseSucceed(() => [] as ReadonlyArray<FleetThreadIndexEntry>),
    );
    const roster = yield* registry.snapshot;
    const remoteResults = yield* Effect.forEach(
      roster.members.filter((member) => member.node.environmentId !== self.node.environmentId),
      (member) =>
        registry.resolveByEnvironmentId(member.node.environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed({
                  entries: [] as ReadonlyArray<FleetThreadIndexEntry>,
                  failures: [
                    {
                      node: member.node.environmentId,
                      nodeName: member.node.name,
                      reason: "unavailable",
                    },
                  ] satisfies ReadonlyArray<FleetThreadIndexFailure>,
                }),
              onSome: (resolved) => {
                const endpoint = preferredEndpoint(resolved.member);
                if (endpoint === undefined) {
                  return Effect.succeed({
                    entries: [] as ReadonlyArray<FleetThreadIndexEntry>,
                    failures: [
                      {
                        node: member.node.environmentId,
                        nodeName: member.node.name,
                        reason: "unavailable",
                      },
                    ] satisfies ReadonlyArray<FleetThreadIndexFailure>,
                  });
                }
                return Effect.all({
                  snapshot: fetchFleetShellSnapshot({
                    baseUrl: endpoint.httpBaseUrl,
                    credential: resolved.credential,
                  }),
                  catalog: fetchFleetProjectCatalog({
                    baseUrl: endpoint.httpBaseUrl,
                    credential: resolved.credential,
                  }),
                }).pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                  Effect.map(({ snapshot, catalog }) => ({
                    entries: indexEntries(
                      resolved.member,
                      snapshot.threads,
                      peerProjectByThread({
                        categories: catalog.categories,
                        threads: snapshot.threads,
                      }),
                    ),
                    failures: [] as ReadonlyArray<FleetThreadIndexFailure>,
                  })),
                  Effect.catchCause(() =>
                    Effect.succeed({
                      entries: [] as ReadonlyArray<FleetThreadIndexEntry>,
                      failures: [
                        {
                          node: member.node.environmentId,
                          nodeName: member.node.name,
                          reason: "unreachable",
                        },
                      ] satisfies ReadonlyArray<FleetThreadIndexFailure>,
                    }),
                  ),
                );
              },
            }),
          ),
        ),
      { concurrency: 4 },
    );
    return yield* threadIndex.refresh(
      [...localEntries, ...remoteResults.flatMap((result) => result.entries)],
      self.node.environmentId,
      remoteResults.flatMap((result) => result.failures),
    );
  });

  const reconcileMember = Effect.fn("FleetReconciler.reconcileMember")(function* (
    resolved: ResolvedFleetMember,
  ) {
    const endpoint = preferredEndpoint(resolved.member);
    if (endpoint === undefined) return;
    const self = yield* ensureSelfInternal(undefined);
    const localBefore = yield* registry.snapshot;
    const remoteRoster = yield* fetchFleetSnapshot({
      baseUrl: endpoint.httpBaseUrl,
      credential: resolved.credential,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const remoteNeedsRoster = fleetRosterRequiresExchange(localBefore, remoteRoster);
    const mergedRoster = yield* registry.merge(remoteRoster);
    if (!fleetRosterRecordsEqual(localBefore, mergedRoster)) {
      yield* clientBootstrapCache.invalidate;
    }

    let localNeedsCredential = false;
    for (const member of mergedRoster.members) {
      if (member.node.environmentId === self.node.environmentId) continue;
      if (Option.isNone(yield* registry.resolveByEnvironmentId(member.node.environmentId))) {
        localNeedsCredential = true;
        break;
      }
    }
    if (!remoteNeedsRoster && !localNeedsCredential) return;

    const reciprocal = yield* auth.createPairingLink({
      label: `Fleet reciprocal for ${resolved.member.node.name}`,
      scopes: [...AuthAdministrativeScopes],
      subject: `fleet-node:${resolved.member.node.environmentId}`,
    });
    const exchanged = yield* exchangeFleetRoster({
      baseUrl: endpoint.httpBaseUrl,
      credential: resolved.credential,
      payload: {
        requester: self,
        roster: mergedRoster,
        reciprocalPairingToken: reciprocal.credential,
      },
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const afterExchange = yield* registry.merge(exchanged.roster);
    if (!fleetRosterRecordsEqual(mergedRoster, afterExchange)) {
      yield* clientBootstrapCache.invalidate;
    }
    yield* revokeTombstonedSessions();
    yield* Effect.forEach(exchanged.introductions, consumeIntroduction, {
      concurrency: 4,
      discard: true,
    });
  });

  const reconcileInternal = Effect.gen(function* () {
    yield* ensureSelfInternal(undefined);
    const failures = new Map<EnvironmentId, FleetReconcileFailureReason>();

    // Three passes are sufficient for the permanent three-node gate and make
    // larger fleets converge on subsequent scheduled/connection reconciles.
    for (let pass = 0; pass < 3; pass += 1) {
      const roster = yield* registry.snapshot;
      let attempted = 0;
      for (const member of roster.members) {
        const resolved = yield* registry.resolveByEnvironmentId(member.node.environmentId);
        if (Option.isNone(resolved)) continue;
        attempted += 1;
        yield* reconcileMember(resolved.value).pipe(
          Effect.tap(() => Effect.sync(() => failures.delete(member.node.environmentId))),
          Effect.catchCause(() =>
            Effect.sync(() => {
              failures.set(member.node.environmentId, "reconcile_failed");
            }),
          ),
        );
      }
      if (attempted === 0) break;
    }
    yield* refreshThreadIndex();

    return {
      roster: yield* registry.snapshot,
      failures: [...failures].map(([environmentId, reason]) => ({ environmentId, reason })),
    };
  }).pipe(Effect.withSpan("FleetReconciler.reconcile"));
  const reconcile: FleetReconcilerShape["reconcile"] = reconcileInternal.pipe(
    Effect.mapError((cause) => new FleetOperationError({ operation: "reconcile", cause })),
  );

  const registerInternal = Effect.fn("FleetReconciler.registerInternal")(function* (
    input: FleetRegisterInput,
  ) {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (baseUrl === null) {
      return yield* new FleetRegistrationError({
        reason: "invalid_base_url",
        name: input.name,
      });
    }
    const roster = yield* registry.snapshot;
    if (roster.members.some((member) => member.node.name === input.name)) {
      return yield* new FleetRegistrationError({
        reason: "duplicate_name",
        name: input.name,
      });
    }

    const credential = yield* resolveRegistrationCredential(baseUrl, input);
    const descriptor = yield* fetchFleetDescriptor(baseUrl).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(
        () =>
          new FleetRegistrationError({
            reason: "node_unreachable",
            name: input.name,
            detail: fleetRegistrationFailureDetail("node_unreachable"),
          }),
      ),
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    const node: FleetNode = {
      environmentId: descriptor.environmentId,
      name: input.name,
      label: descriptor.label,
      platform: descriptor.platform,
      endpoints: [endpointFor(baseUrl, descriptor.label)],
      sshUser: input.sshUser ?? null,
      updatedAt: now,
    };
    const member: FleetMember = { node, registeredAt: now, updatedAt: now };
    yield* ensureSelfInternal(input.reciprocalBaseUrl);
    yield* registry.upsert(member, credential.credential);
    yield* clientBootstrapCache.invalidate;

    // Registration succeeds once the durable edge exists. Reconciliation is
    // best effort so an older peer can still be registered and upgraded.
    yield* reconcileInternal.pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Initial fleet reconciliation deferred", {
          environmentId: member.node.environmentId,
        }),
      ),
    );
    const reconciledRoster = yield* registry.snapshot;
    const reconciledMember = reconciledRoster.members.find(
      (candidate) => candidate.node.environmentId === member.node.environmentId,
    );
    const reasserted = reassertRegisteredFleetMember(
      member,
      nextFleetRegistrationTimestamp(DateTime.formatIso(yield* DateTime.now), [
        member.updatedAt,
        ...(reconciledMember === undefined ? [] : [reconciledMember.updatedAt]),
      ]),
    );
    yield* registry.upsert(reasserted);
    yield* clientBootstrapCache.invalidate;
    return { node: reasserted.node, roster: yield* registry.snapshot };
  });
  const register: FleetReconcilerShape["register"] = (input) =>
    registerInternal(input).pipe(
      Effect.mapError((cause) =>
        isFleetRegistrationError(cause)
          ? cause
          : new FleetOperationError({ operation: "register", cause }),
      ),
    );

  const exchangeInternal = Effect.fn("FleetReconciler.exchangeInternal")(function* (
    input: FleetExchangeInput,
  ) {
    const requesterEndpoint = preferredEndpoint(input.requester);
    if (requesterEndpoint === undefined) {
      return { roster: yield* registry.snapshot, introductions: [] };
    }
    const reciprocal = yield* exchangeFleetPairingToken({
      baseUrl: requesterEndpoint.httpBaseUrl,
      pairingToken: input.reciprocalPairingToken,
      label: `StarCode reciprocal fleet node ${input.requester.node.name}`,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const requesterCredentialBefore = yield* registry.resolveByEnvironmentId(
      input.requester.node.environmentId,
    );
    const rosterBefore = yield* registry.snapshot;
    const rosterAfter = yield* registry.merge({
      ...input.roster,
      members: [...input.roster.members, input.requester],
    });
    if (!fleetRosterRecordsEqual(rosterBefore, rosterAfter)) {
      yield* clientBootstrapCache.invalidate;
    }
    yield* revokeTombstonedSessions();
    const afterMerge = yield* registry.snapshot;
    const requesterActive = afterMerge.members.some(
      (member) => member.node.environmentId === input.requester.node.environmentId,
    );
    if (requesterActive) {
      yield* registry.storeCredential(input.requester.node.environmentId, reciprocal.access_token);
      if (Option.isNone(requesterCredentialBefore)) {
        yield* clientBootstrapCache.invalidate;
      }
    }
    const self = yield* ensureSelfInternal(undefined);
    const roster = yield* registry.snapshot;

    const introductions = yield* Effect.forEach(
      roster.members.filter(
        (member) =>
          member.node.environmentId !== input.requester.node.environmentId &&
          member.node.environmentId !== self.node.environmentId,
      ),
      (member) =>
        registry.resolveByEnvironmentId(member.node.environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<FleetIntroduction>()),
              onSome: (resolved) => {
                const endpoint = preferredEndpoint(resolved.member);
                if (endpoint === undefined) return Effect.succeed(Option.none<FleetIntroduction>());
                return mintRemoteFleetPairingCredential({
                  baseUrl: endpoint.httpBaseUrl,
                  credential: resolved.credential,
                  label: `Fleet introduction for ${input.requester.node.name}`,
                }).pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                  Effect.map((pairing) =>
                    Option.some({
                      node: resolved.member.node,
                      pairingToken: pairing.credential,
                    } satisfies FleetIntroduction),
                  ),
                  Effect.catchCause(() => Effect.succeed(Option.none<FleetIntroduction>())),
                );
              },
            }),
          ),
        ),
      { concurrency: 4 },
    );

    return {
      roster: yield* registry.snapshot,
      introductions: introductions.flatMap((introduction) =>
        Option.isSome(introduction) ? [introduction.value] : [],
      ),
    };
  });
  const exchange: FleetReconcilerShape["exchange"] = (input) =>
    exchangeInternal(input).pipe(
      Effect.mapError((cause) => new FleetOperationError({ operation: "exchange", cause })),
    );

  const clientBootstrapInternal = Effect.fn("FleetReconciler.clientBootstrap")(function* (
    anchorScopes: Iterable<AuthEnvironmentScope>,
  ) {
    const clientScopes = deriveFleetClientScopes(anchorScopes);
    const authorityKey = [...clientScopes].sort().join(" ");
    const bootstrapNow = yield* DateTime.now;
    const bootstrapNowEpochMs = DateTime.toEpochMillis(bootstrapNow);
    const cachedRoster = yield* registry.snapshot;
    const cached = yield* clientBootstrapCache.get(
      authorityKey,
      cachedRoster.revision,
      bootstrapNowEpochMs,
    );
    if (Option.isSome(cached)) return cached.value;
    const self = yield* ensureSelfInternal(undefined);
    const localSession = yield* auth.issueSession({
      subject: "fleet-client-bootstrap",
      label: "Fleet client bootstrap",
      scopes: [...clientScopes],
      ttl: Duration.minutes(10),
    });
    const localEndpoint = preferredEndpoint(self);
    const nodes: Array<FleetClientBootstrapNode> = [];
    if (localEndpoint !== undefined) {
      nodes.push({
        nodeId: self.node.name,
        environmentId: self.node.environmentId,
        label: self.node.label,
        endpoint: {
          httpBaseUrl: localEndpoint.httpBaseUrl,
          wsBaseUrl: localEndpoint.wsBaseUrl,
        },
        credential: {
          bearerToken: localSession.token,
          expiresAtEpochMs: DateTime.toEpochMillis(localSession.expiresAt),
        },
      });
    }

    const roster = yield* registry.snapshot;
    const remoteCandidates = roster.members
      .filter((member) => member.node.environmentId !== self.node.environmentId)
      .map((member) =>
        registry.resolveByEnvironmentId(member.node.environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<FleetClientBootstrapNode>()),
              onSome: (resolved) => {
                const endpoint = preferredEndpoint(resolved.member);
                if (endpoint === undefined)
                  return Effect.succeed(Option.none<FleetClientBootstrapNode>());
                return mintRemoteStandardClientAccess({
                  baseUrl: endpoint.httpBaseUrl,
                  credential: resolved.credential,
                  label: "Fleet client bootstrap",
                  scopes: clientScopes,
                }).pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                  Effect.map((access) =>
                    Option.some({
                      nodeId: resolved.member.node.name,
                      environmentId: resolved.member.node.environmentId,
                      label: resolved.member.node.label,
                      endpoint: {
                        httpBaseUrl: endpoint.httpBaseUrl,
                        wsBaseUrl: endpoint.wsBaseUrl,
                      },
                      credential: {
                        bearerToken: access.access_token,
                        expiresAtEpochMs:
                          DateTime.toEpochMillis(bootstrapNow) +
                          Math.max(0, access.expires_in) * 1_000,
                      },
                    } satisfies FleetClientBootstrapNode),
                  ),
                  Effect.catchCause(() => Effect.succeed(Option.none<FleetClientBootstrapNode>())),
                );
              },
            }),
          ),
          Effect.catchCause(() => Effect.succeed(Option.none<FleetClientBootstrapNode>())),
        ),
      );
    nodes.push(...(yield* collectAvailableFleetBootstrapNodes(remoteCandidates)));
    const result = { revision: roster.revision, nodes } satisfies FleetClientBootstrapResult;
    // Polling viewers reuse the same short-lived sessions for eight minutes;
    // the two-minute safety window leaves ample time for WebSocket reconnect.
    yield* clientBootstrapCache.put({
      authorityKey,
      result,
      refreshAfterEpochMs: bootstrapNowEpochMs + Duration.toMillis(Duration.minutes(8)),
    });
    return result;
  });
  const clientBootstrap: FleetReconcilerShape["clientBootstrap"] = (anchorScopes) =>
    clientBootstrapInternal(anchorScopes).pipe(
      Effect.mapError((cause) => new FleetOperationError({ operation: "bootstrap", cause })),
    );

  const remove: FleetReconcilerShape["remove"] = Effect.fn("FleetReconciler.remove")(
    function* (environmentId, now) {
      const result = yield* registry.remove(environmentId, now);
      const sessions = yield* auth.listSessions();
      yield* Effect.forEach(
        sessions.filter((session) => session.subject === `fleet-node:${environmentId}`),
        (session) => auth.revokeSession(session.sessionId),
        { concurrency: 4, discard: true },
      );
      yield* clientBootstrapCache.invalidate;
      return result;
    },
    Effect.mapError((cause) => new FleetOperationError({ operation: "reconcile", cause })),
  );

  return FleetReconciler.of({
    register,
    reconcile,
    exchange,
    clientBootstrap,
    ensureSelf,
    remove,
  });
});

export const layer = Layer.effect(FleetReconciler, make);
