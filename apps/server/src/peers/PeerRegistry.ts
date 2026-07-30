/**
 * PeerRegistry - the set of remote starcode environments this one can read.
 *
 * Persistence mirrors `serverSettings.ts`: a JSON file under the state dir for
 * the metadata, guarded by a write semaphore, with the actual bearer credential
 * held in `ServerSecretStore` (0600, outside the JSON) so a peers file that
 * leaks carries no authority.
 *
 * Registration reuses the existing RFC 8693 token exchange; there is no second
 * auth scheme here. The exchange requests exactly the scopes the registration's
 * credential class calls for, and the peer's own anti-privilege-escalation
 * check refuses to widen that.
 *
 * Both directions are then re-checked locally against what the peer says it
 * granted, so an entry's stored class and its stored authority cannot diverge:
 * a `read` peer that somehow came back operate-capable is refused rather than
 * silently downgraded in name only.
 *
 * @module PeerRegistry
 */
import {
  AuthEnvironmentScope,
  PeerEnvironment,
  type PeerCredentialClass,
  type PeerName,
  type PeerRegisterInput,
} from "@starcode/contracts";
import { parseOAuthScope } from "@starcode/shared/oauthScope";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import { fromJsonStringPretty, fromLenientJson } from "@starcode/shared/schemaJson";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  exchangePeerPairingToken,
  fetchPeerDescriptor,
  fetchPeerSessionState,
  judgePeerScopes,
  normalizePeerBaseUrl,
  peerCredentialScopes,
} from "./PeerEnvironmentClient.ts";

const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

export class PeerRegistryStateError extends Schema.TaggedErrorClass<PeerRegistryStateError>()(
  "PeerRegistryStateError",
  {
    operation: Schema.Literals(["load", "save", "credential"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the peer registry.`;
  }
}

export const PeerRegistrationFailureReason = Schema.Literals([
  "invalid_base_url",
  "duplicate_name",
  "exchange_rejected",
  "token_rejected",
  "peer_unreachable",
  "scope_not_granted",
  "scope_too_broad",
]);
export type PeerRegistrationFailureReason = typeof PeerRegistrationFailureReason.Type;

export class PeerRegistrationError extends Schema.TaggedErrorClass<PeerRegistrationError>()(
  "PeerRegistrationError",
  {
    reason: PeerRegistrationFailureReason,
    name: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Could not register peer ${this.name}: ${this.reason}.`;
  }
}

const PeerRegistryFile = Schema.Struct({
  version: Schema.Literal(1),
  peers: Schema.Array(PeerEnvironment),
});
type PeerRegistryFile = typeof PeerRegistryFile.Type;

const decodePeerRegistryFile = Schema.decodeUnknownEffect(fromLenientJson(PeerRegistryFile));
const encodePeerRegistryFile = Schema.encodeUnknownEffect(fromJsonStringPretty(PeerRegistryFile));

const EMPTY_REGISTRY: PeerRegistryFile = { version: 1, peers: [] };

/** Credentials are keyed by name so removing a peer can drop its secret. */
const peerSecretName = (name: string): string =>
  `peer-${Buffer.from(name, "utf8").toString("base64url")}`;

export interface ResolvedPeer {
  readonly peer: PeerEnvironment;
  readonly credential: string;
}

export interface PeerRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<PeerEnvironment>, PeerRegistryStateError>;
  readonly register: (
    input: PeerRegisterInput,
  ) => Effect.Effect<PeerEnvironment, PeerRegistryStateError | PeerRegistrationError>;
  readonly remove: (name: PeerName) => Effect.Effect<boolean, PeerRegistryStateError>;
  /** Record (or clear, with null) how to log into an already-registered peer. False when it is unknown. */
  readonly setSshUser: (
    name: PeerName,
    sshUser: string | null,
  ) => Effect.Effect<boolean, PeerRegistryStateError>;
  /** Peer plus its bearer credential. `None` when the peer or secret is gone. */
  readonly resolve: (
    name: PeerName,
  ) => Effect.Effect<Option.Option<ResolvedPeer>, PeerRegistryStateError>;
}

export class PeerRegistry extends Context.Service<PeerRegistry, PeerRegistryShape>()(
  "starcode/peers/PeerRegistry",
) {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const readFile: Effect.Effect<PeerRegistryFile, PeerRegistryStateError> = fs
    .readFileString(config.peersPath)
    .pipe(
      Effect.map(Option.some),
      // A missing peers file is the unregistered steady state, not a fault.
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new PeerRegistryStateError({ operation: "load", cause })),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(EMPTY_REGISTRY),
          onSome: (contents) =>
            decodePeerRegistryFile(contents).pipe(
              Effect.mapError((cause) => new PeerRegistryStateError({ operation: "load", cause })),
            ),
        }),
      ),
    );

  const writeFile = (next: PeerRegistryFile) =>
    encodePeerRegistryFile(next).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: config.peersPath, contents: `${contents}\n` }),
      ),
      // The platform services are captured here rather than surfaced on the
      // service interface, so callers of the registry need no filesystem context.
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new PeerRegistryStateError({ operation: "save", cause })),
    );

  const readCredential = (name: string) =>
    secretStore.get(peerSecretName(name)).pipe(
      Effect.map(Option.map((bytes) => decoder.decode(bytes))),
      Effect.mapError((cause) => new PeerRegistryStateError({ operation: "credential", cause })),
    );

  const writeCredential = (name: string, credential: string) =>
    secretStore
      .set(peerSecretName(name), encoder.encode(credential))
      .pipe(
        Effect.mapError((cause) => new PeerRegistryStateError({ operation: "credential", cause })),
      );

  const removeCredential = (name: string) =>
    secretStore
      .remove(peerSecretName(name))
      .pipe(
        Effect.mapError((cause) => new PeerRegistryStateError({ operation: "credential", cause })),
      );

  const list: PeerRegistryShape["list"] = readFile.pipe(
    Effect.map((file) => file.peers),
    Effect.withSpan("PeerRegistry.list"),
  );

  const resolve: PeerRegistryShape["resolve"] = Effect.fn("PeerRegistry.resolve")(function* (name) {
    const file = yield* readFile;
    const peer = file.peers.find((candidate) => candidate.name === name);
    if (peer === undefined) return Option.none<ResolvedPeer>();
    const credential = yield* readCredential(name);
    return Option.map(credential, (value) => ({ peer, credential: value }) satisfies ResolvedPeer);
  });

  interface ResolvedCredential {
    readonly credential: string;
    readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly credentialExpiresAt: string;
  }

  /**
   * Turns either credential input into a stored bearer plus the scopes the
   * peer says it carries. Both branches end up asking the peer, never the
   * caller, what the credential is actually good for.
   */
  const resolveCredential = Effect.fn("PeerRegistry.resolveCredential")(function* (
    baseUrl: string,
    input: PeerRegisterInput,
    credentialClass: PeerCredentialClass,
  ): Effect.fn.Return<ResolvedCredential, PeerRegistrationError> {
    const now = yield* DateTime.now;
    if ("token" in input.credential) {
      const state = yield* fetchPeerSessionState({
        baseUrl,
        credential: input.credential.token,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError(
          (cause) =>
            new PeerRegistrationError({
              reason: "peer_unreachable",
              name: input.name,
              detail: Cause.pretty(Cause.fail(cause)),
            }),
        ),
      );
      if (!state.authenticated) {
        return yield* new PeerRegistrationError({
          reason: "token_rejected",
          name: input.name,
          detail: "The peer did not recognize this token.",
        });
      }
      return {
        credential: input.credential.token,
        grantedScopes: state.scopes ?? [],
        // A session token carries its own expiry; when the peer does not
        // report one, record the request time so the entry still shows an age.
        credentialExpiresAt: DateTime.formatIso(
          state.expiresAt === undefined ? now : state.expiresAt,
        ),
      };
    }

    // Redeem first: a pairing token is single-use, so persisting before the
    // exchange would leave an entry whose credential can never be obtained.
    const exchanged = yield* exchangePeerPairingToken({
      baseUrl,
      pairingToken: input.credential.pairingToken,
      label: `starcode peer ${input.name}`,
      credentialClass,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(
        (cause) =>
          new PeerRegistrationError({
            reason: "exchange_rejected",
            name: input.name,
            detail: Cause.pretty(Cause.fail(cause)),
          }),
      ),
    );
    return {
      credential: exchanged.access_token,
      grantedScopes: (parseOAuthScope(exchanged.scope) ?? []).filter(isAuthEnvironmentScope),
      credentialExpiresAt: DateTime.formatIso(
        DateTime.addDuration(now, `${Math.max(exchanged.expires_in, 0)} seconds`),
      ),
    };
  });

  const register: PeerRegistryShape["register"] = Effect.fn("PeerRegistry.register")(
    function* (input) {
      const baseUrl = normalizePeerBaseUrl(input.baseUrl);
      if (baseUrl === null) {
        return yield* new PeerRegistrationError({
          reason: "invalid_base_url",
          name: input.name,
          detail: "Peer baseUrl must be an absolute http(s) URL.",
        });
      }

      const existing = yield* list;
      if (existing.some((peer) => peer.name === input.name)) {
        return yield* new PeerRegistrationError({ reason: "duplicate_name", name: input.name });
      }

      const credentialClass = input.credentialClass ?? "read";
      const requiredScopes = peerCredentialScopes(credentialClass);
      const resolved = yield* resolveCredential(baseUrl, input, credentialClass);

      // Least privilege is enforced here rather than trusted from the caller:
      // both paths report the scopes the *peer* says the credential carries,
      // and the required set is exact rather than a floor. A read registration
      // handed an operate-capable token is refused just as firmly as an
      // operate registration handed an administrative one — the class the
      // operator asked for is the authority the entry ends up holding.
      const verdict = judgePeerScopes(credentialClass, resolved.grantedScopes);
      if (!verdict.ok) {
        return yield* new PeerRegistrationError({
          reason: verdict.reason,
          name: input.name,
          detail:
            verdict.reason === "scope_not_granted"
              ? `Peer granted "${resolved.grantedScopes.join(" ")}" but a ${credentialClass} peer requires ${verdict.missing.join(", ")}.`
              : `Peer credential also grants ${verdict.excess.join(", ")}, which a ${credentialClass} peer must not hold. Issue a token scoped to exactly ${requiredScopes.join(", ")}.`,
        });
      }

      // Identity is best effort: a peer that redeemed a token but cannot serve
      // its descriptor is still usable, so this must not fail registration.
      const descriptor = yield* fetchPeerDescriptor(baseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.map(Option.some),
        Effect.catchCause(() => Effect.succeed(Option.none())),
      );

      const now = yield* DateTime.now;
      const registeredAt = DateTime.formatIso(now);

      const peer: PeerEnvironment = {
        name: input.name,
        baseUrl,
        credentialClass,
        environmentId: Option.match(descriptor, {
          onNone: () => null,
          onSome: (value) => value.environmentId,
        }),
        label: Option.match(descriptor, {
          onNone: () => null,
          onSome: (value) => value.label,
        }),
        sshUser: input.sshUser ?? null,
        scopes: resolved.grantedScopes,
        registeredAt,
        credentialExpiresAt: resolved.credentialExpiresAt,
      };

      yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const file = yield* readFile;
          if (file.peers.some((candidate) => candidate.name === peer.name)) {
            return yield* new PeerRegistrationError({ reason: "duplicate_name", name: peer.name });
          }
          yield* writeCredential(peer.name, resolved.credential);
          yield* writeFile({ version: 1, peers: [...file.peers, peer] });
        }),
      );

      return peer;
    },
  );

  const remove: PeerRegistryShape["remove"] = Effect.fn("PeerRegistry.remove")(function* (name) {
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const file = yield* readFile;
        const remaining = file.peers.filter((peer) => peer.name !== name);
        if (remaining.length === file.peers.length) return false;
        yield* writeFile({ version: 1, peers: remaining });
        yield* removeCredential(name);
        return true;
      }),
    );
  });

  /**
   * Its own operation rather than a re-register, because registering redeems a
   * credential: pairing tokens are single-use, and making an operator mint one
   * just to record a login name would be a worse trade than an extra method.
   * Returns false for an unknown peer instead of creating one — this only edits
   * a peer that already exists.
   */
  const setSshUser: PeerRegistryShape["setSshUser"] = Effect.fn("PeerRegistry.setSshUser")(
    function* (name, sshUser) {
      return yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const file = yield* readFile;
          if (!file.peers.some((peer) => peer.name === name)) return false;
          yield* writeFile({
            version: 1,
            peers: file.peers.map((peer) => (peer.name === name ? { ...peer, sshUser } : peer)),
          });
          return true;
        }),
      );
    },
  );

  return PeerRegistry.of({ list, register, remove, resolve, setSshUser });
});

export const layer: Layer.Layer<
  PeerRegistry,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | HttpClient.HttpClient
> = Layer.effect(PeerRegistry, make);
