/**
 * Durable fleet roster storage.
 *
 * fleet.json contains only public node metadata and tombstones. Administrative
 * node credentials are keyed by environment id in ServerSecretStore. A legacy
 * peers.json is read once as a migration source and is never written again.
 *
 * @module FleetRegistry
 */
import {
  AuthAdministrativeScopes,
  AuthEnvironmentScopes,
  EnvironmentId,
  FleetMember,
  FleetRoster,
  IsoDateTime,
  PeerBaseUrl,
  PeerName,
  TrimmedNonEmptyString,
  type FleetNode,
} from "@starcode/contracts";
import { createAdvertisedEndpoint } from "@starcode/shared/advertisedEndpoint";
import { fromJsonStringPretty, fromLenientJson } from "@starcode/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import {
  EMPTY_FLEET_ROSTER,
  mergeFleetRosters,
  pruneExpiredFleetTombstones,
  tombstoneFleetMember,
  upsertFleetMember,
} from "./FleetRoster.ts";

export class FleetRegistryStateError extends Schema.TaggedErrorClass<FleetRegistryStateError>()(
  "FleetRegistryStateError",
  {
    operation: Schema.Literals(["load", "save", "credential", "migrate"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the fleet registry.`;
  }
}

const LegacyPeerEnvironment = Schema.Struct({
  name: PeerName,
  baseUrl: PeerBaseUrl,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.NullOr(TrimmedNonEmptyString),
  sshUser: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  scopes: AuthEnvironmentScopes,
  registeredAt: IsoDateTime,
  credentialExpiresAt: IsoDateTime,
});
type LegacyPeerEnvironment = typeof LegacyPeerEnvironment.Type;

const LegacyPeerRegistryFile = Schema.Struct({
  version: Schema.Literal(1),
  peers: Schema.Array(LegacyPeerEnvironment),
});
type LegacyPeerRegistryFile = typeof LegacyPeerRegistryFile.Type;

const decodeFleetRoster = Schema.decodeUnknownEffect(fromLenientJson(FleetRoster));
const encodeFleetRoster = Schema.encodeUnknownEffect(fromJsonStringPretty(FleetRoster));
const decodeLegacyRegistry = Schema.decodeUnknownEffect(fromLenientJson(LegacyPeerRegistryFile));

/** Credentials are keyed by stable environment id, never user-editable display name. */
export const fleetNodeSecretName = (environmentId: EnvironmentId): string =>
  `fleet-node-${Buffer.from(environmentId, "utf8").toString("base64url")}`;

/** One-release read key used to migrate credentials stored by PeerRegistry. */
const legacyPeerSecretName = (name: string): string =>
  `peer-${Buffer.from(name, "utf8").toString("base64url")}`;

export interface ResolvedFleetMember {
  readonly member: FleetMember;
  readonly credential: string;
}

export interface FleetRegistryShape {
  readonly snapshot: Effect.Effect<FleetRoster, FleetRegistryStateError>;
  readonly merge: (remote: FleetRoster) => Effect.Effect<FleetRoster, FleetRegistryStateError>;
  readonly upsert: (
    member: FleetMember,
    credential?: string,
  ) => Effect.Effect<FleetRoster, FleetRegistryStateError>;
  readonly remove: (
    environmentId: EnvironmentId,
    now: string,
  ) => Effect.Effect<
    { readonly removed: boolean; readonly roster: FleetRoster },
    FleetRegistryStateError
  >;
  readonly resolveByEnvironmentId: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<ResolvedFleetMember>, FleetRegistryStateError>;
  readonly resolveByName: (
    name: PeerName,
  ) => Effect.Effect<Option.Option<ResolvedFleetMember>, FleetRegistryStateError>;
  readonly storeCredential: (
    environmentId: EnvironmentId,
    credential: string,
  ) => Effect.Effect<void, FleetRegistryStateError>;
  readonly setSshUser: (
    name: PeerName,
    sshUser: string | null,
    now: string,
  ) => Effect.Effect<boolean, FleetRegistryStateError>;
}

export class FleetRegistry extends Context.Service<FleetRegistry, FleetRegistryShape>()(
  "starcode/fleet/FleetRegistry",
) {}

const migratePeer = (peer: LegacyPeerEnvironment): FleetMember => {
  const environmentId = EnvironmentId.make(peer.environmentId ?? `legacy:${peer.name}`);
  const node: FleetNode = {
    environmentId,
    name: peer.name,
    label: peer.label ?? peer.name,
    platform: { os: "unknown", arch: "other" },
    endpoints: [
      createAdvertisedEndpoint({
        id: "legacy-peer",
        label: "Migrated peer endpoint",
        provider: {
          id: "manual",
          label: "Manual",
          kind: "manual",
          isAddon: false,
        },
        httpBaseUrl: peer.baseUrl,
        reachability: "private-network",
        source: "user",
        isDefault: true,
      }),
    ],
    sshUser: peer.sshUser,
    updatedAt: peer.registeredAt,
  };
  return {
    node,
    registeredAt: peer.registeredAt,
    updatedAt: peer.registeredAt,
  };
};

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const readOptional = (filePath: string) =>
    fs.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new FleetRegistryStateError({ operation: "load", cause })),
      ),
    );

  const writeRoster = (roster: FleetRoster) =>
    encodeFleetRoster(roster).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: config.fleetPath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new FleetRegistryStateError({ operation: "save", cause })),
    );

  const readCredential = (environmentId: EnvironmentId) =>
    secretStore.get(fleetNodeSecretName(environmentId)).pipe(
      Effect.map(Option.map((bytes) => decoder.decode(bytes))),
      Effect.mapError((cause) => new FleetRegistryStateError({ operation: "credential", cause })),
    );

  const storeCredential: FleetRegistryShape["storeCredential"] = (environmentId, credential) =>
    secretStore.set(fleetNodeSecretName(environmentId), encoder.encode(credential)).pipe(
      Effect.mapError((cause) => new FleetRegistryStateError({ operation: "credential", cause })),
      Effect.withSpan("FleetRegistry.storeCredential"),
    );

  const removeCredential = (environmentId: EnvironmentId) =>
    secretStore
      .remove(fleetNodeSecretName(environmentId))
      .pipe(
        Effect.mapError((cause) => new FleetRegistryStateError({ operation: "credential", cause })),
      );

  const migrateLegacy = Effect.fn("FleetRegistry.migrateLegacy")(function* (
    legacy: LegacyPeerRegistryFile,
  ) {
    const nowEpochMs = DateTime.toEpochMillis(yield* DateTime.now);
    const migrated = yield* Effect.forEach(
      legacy.peers,
      (peer) =>
        secretStore.get(legacyPeerSecretName(peer.name)).pipe(
          Effect.mapError((cause) => new FleetRegistryStateError({ operation: "migrate", cause })),
          Effect.map((credential) => {
            const hasAdministrativeAuthority = AuthAdministrativeScopes.every((scope) =>
              peer.scopes.includes(scope),
            );
            const expiresAtEpochMs = Date.parse(peer.credentialExpiresAt);
            if (
              Option.isNone(credential) ||
              !hasAdministrativeAuthority ||
              !Number.isFinite(expiresAtEpochMs) ||
              expiresAtEpochMs <= nowEpochMs
            ) {
              return Option.none<{
                readonly member: FleetMember;
                readonly credential: Uint8Array;
              }>();
            }
            return Option.some({
              member: migratePeer(peer),
              credential: credential.value,
            });
          }),
        ),
      { concurrency: 4 },
    );
    const valid = migrated.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
    const members = valid.map((entry) => entry.member);
    const roster: FleetRoster = {
      version: 1,
      revision: members.length > 0 ? 1 : 0,
      members,
      tombstones: [],
    };

    for (const entry of valid) {
      yield* secretStore
        .set(fleetNodeSecretName(entry.member.node.environmentId), entry.credential)
        .pipe(
          Effect.mapError((cause) => new FleetRegistryStateError({ operation: "migrate", cause })),
        );
    }
    yield* writeRoster(roster);
    yield* Effect.forEach(
      legacy.peers,
      (peer) =>
        secretStore
          .remove(legacyPeerSecretName(peer.name))
          .pipe(
            Effect.mapError(
              (cause) => new FleetRegistryStateError({ operation: "migrate", cause }),
            ),
          ),
      { concurrency: 4, discard: true },
    );
    yield* fs
      .remove(config.peersPath, { force: true })
      .pipe(
        Effect.mapError((cause) => new FleetRegistryStateError({ operation: "migrate", cause })),
      );
    return roster;
  });

  const loadRosterDocumentUnlocked: Effect.Effect<FleetRoster, FleetRegistryStateError> =
    readOptional(config.fleetPath).pipe(
      Effect.flatMap(
        Option.match({
          onSome: (contents) =>
            decodeFleetRoster(contents).pipe(
              Effect.mapError((cause) => new FleetRegistryStateError({ operation: "load", cause })),
            ),
          onNone: () =>
            readOptional(config.peersPath).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(EMPTY_FLEET_ROSTER),
                  onSome: (contents) =>
                    decodeLegacyRegistry(contents).pipe(
                      Effect.mapError(
                        (cause) => new FleetRegistryStateError({ operation: "migrate", cause }),
                      ),
                      Effect.flatMap(migrateLegacy),
                    ),
                }),
              ),
            ),
        }),
      ),
    );

  const loadRosterUnlocked: Effect.Effect<FleetRoster, FleetRegistryStateError> = Effect.gen(
    function* () {
      const roster = yield* loadRosterDocumentUnlocked;
      const nowEpochMs = DateTime.toEpochMillis(yield* DateTime.now);
      const pruned = pruneExpiredFleetTombstones(roster, nowEpochMs);
      if (pruned !== roster) yield* writeRoster(pruned);
      return pruned;
    },
  );

  const snapshot: FleetRegistryShape["snapshot"] = writeSemaphore
    .withPermits(1)(loadRosterUnlocked)
    .pipe(Effect.withSpan("FleetRegistry.snapshot"));

  const merge: FleetRegistryShape["merge"] = Effect.fn("FleetRegistry.merge")(function* (remote) {
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const local = yield* loadRosterUnlocked;
        const nowEpochMs = DateTime.toEpochMillis(yield* DateTime.now);
        const merged = mergeFleetRosters(local, pruneExpiredFleetTombstones(remote, nowEpochMs));
        const removedEnvironmentIds = local.members
          .map((member) => member.node.environmentId)
          .filter(
            (environmentId) =>
              !merged.members.some((member) => member.node.environmentId === environmentId),
          );
        const [encodedLocal, encodedMerged] = yield* Effect.all([
          encodeFleetRoster(local),
          encodeFleetRoster(merged),
        ]).pipe(
          Effect.mapError((cause) => new FleetRegistryStateError({ operation: "save", cause })),
        );
        if (encodedMerged !== encodedLocal) {
          yield* writeRoster(merged);
          yield* Effect.forEach(removedEnvironmentIds, removeCredential, {
            concurrency: 4,
            discard: true,
          });
        }
        return merged;
      }),
    );
  });

  const upsert: FleetRegistryShape["upsert"] = Effect.fn("FleetRegistry.upsert")(
    function* (member, credential) {
      return yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadRosterUnlocked;
          const existing = current.members.find(
            (candidate) => candidate.node.environmentId === member.node.environmentId,
          );
          const hasTombstone = current.tombstones.some(
            (candidate) => candidate.environmentId === member.node.environmentId,
          );
          const unchanged = !hasTombstone && Equal.equals(existing, member);
          const next = unchanged ? current : upsertFleetMember(current, member);
          if (credential !== undefined) {
            yield* storeCredential(member.node.environmentId, credential);
          }
          if (!unchanged) yield* writeRoster(next);
          return next;
        }),
      );
    },
  );

  const remove: FleetRegistryShape["remove"] = Effect.fn("FleetRegistry.remove")(
    function* (environmentId, now) {
      return yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadRosterUnlocked;
          const result = tombstoneFleetMember(current, environmentId, now);
          if (result.roster !== current) yield* writeRoster(result.roster);
          if (result.removed) yield* removeCredential(environmentId);
          return result;
        }),
      );
    },
  );

  const resolveByEnvironmentId: FleetRegistryShape["resolveByEnvironmentId"] = Effect.fn(
    "FleetRegistry.resolveByEnvironmentId",
  )(function* (environmentId) {
    const roster = yield* snapshot;
    const member = roster.members.find(
      (candidate) => candidate.node.environmentId === environmentId,
    );
    if (member === undefined) return Option.none<ResolvedFleetMember>();
    const credential = yield* readCredential(environmentId);
    return Option.map(credential, (value) => ({ member, credential: value }));
  });

  const resolveByName: FleetRegistryShape["resolveByName"] = Effect.fn(
    "FleetRegistry.resolveByName",
  )(function* (name) {
    const roster = yield* snapshot;
    const member = roster.members.find((candidate) => candidate.node.name === name);
    if (member === undefined) return Option.none<ResolvedFleetMember>();
    const credential = yield* readCredential(member.node.environmentId);
    return Option.map(credential, (value) => ({ member, credential: value }));
  });

  const setSshUser: FleetRegistryShape["setSshUser"] = Effect.fn("FleetRegistry.setSshUser")(
    function* (name, sshUser, now) {
      return yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadRosterUnlocked;
          const existing = current.members.find((candidate) => candidate.node.name === name);
          if (existing === undefined) return false;
          const updated: FleetMember = {
            ...existing,
            node: { ...existing.node, sshUser, updatedAt: now },
            updatedAt: now,
          };
          yield* writeRoster(upsertFleetMember(current, updated));
          return true;
        }),
      );
    },
  );

  return FleetRegistry.of({
    snapshot,
    merge,
    upsert,
    remove,
    resolveByEnvironmentId,
    resolveByName,
    storeCredential,
    setSshUser,
  });
});

export const layer = Layer.effect(FleetRegistry, make);
