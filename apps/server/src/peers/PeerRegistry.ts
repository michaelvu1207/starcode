/**
 * One-release compatibility adapter for the former peer registry.
 *
 * New state is owned by FleetRegistry and written to fleet.json. The legacy
 * peer-shaped API remains so running MCP sessions and older clients continue
 * to work while they move to `/api/fleet`.
 *
 * @module PeerRegistry
 */
import { type PeerEnvironment, type PeerName, type PeerRegisterInput } from "@starcode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  FleetReconciler,
  isFleetRegistrationError,
  type FleetRegistrationFailureReason,
} from "../fleet/FleetReconciler.ts";
import {
  FleetRegistry,
  FleetRegistryStateError,
  type ResolvedFleetMember,
} from "../fleet/FleetRegistry.ts";

const isFleetRegistryStateError = Schema.is(FleetRegistryStateError);

export class PeerRegistryStateError extends Schema.TaggedErrorClass<PeerRegistryStateError>()(
  "PeerRegistryStateError",
  {
    operation: Schema.Literals(["load", "save", "credential"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the peer registry compatibility view.`;
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
  readonly setSshUser: (
    name: PeerName,
    sshUser: string | null,
  ) => Effect.Effect<boolean, PeerRegistryStateError>;
  readonly resolve: (
    name: PeerName,
  ) => Effect.Effect<Option.Option<ResolvedPeer>, PeerRegistryStateError>;
}

export class PeerRegistry extends Context.Service<PeerRegistry, PeerRegistryShape>()(
  "starcode/peers/PeerRegistry",
) {}

const endpointOf = (resolved: ResolvedFleetMember) =>
  resolved.member.node.endpoints.find((endpoint) => endpoint.isDefault === true) ??
  resolved.member.node.endpoints[0];

const peerFromResolved = (resolved: ResolvedFleetMember): PeerEnvironment | null => {
  const endpoint = endpointOf(resolved);
  if (endpoint === undefined) return null;
  return {
    name: resolved.member.node.name,
    baseUrl: endpoint.httpBaseUrl,
    environmentId: resolved.member.node.environmentId,
    label: resolved.member.node.label,
    sshUser: resolved.member.node.sshUser,
    registeredAt: resolved.member.registeredAt,
  };
};

const peerFromMember = (member: ResolvedFleetMember["member"]): PeerEnvironment | null =>
  peerFromResolved({ member, credential: "" });

const mapFleetStateError = (cause: unknown): PeerRegistryStateError =>
  new PeerRegistryStateError({
    operation:
      isFleetRegistryStateError(cause) && cause.operation === "credential"
        ? "credential"
        : isFleetRegistryStateError(cause) && cause.operation === "save"
          ? "save"
          : "load",
    cause,
  });

const mapRegistrationReason = (
  reason: FleetRegistrationFailureReason,
): PeerRegistrationFailureReason => {
  switch (reason) {
    case "invalid_base_url":
    case "duplicate_name":
    case "exchange_rejected":
    case "token_rejected":
      return reason;
    case "node_unreachable":
      return "peer_unreachable";
    case "administrative_scope_required":
      return "scope_not_granted";
  }
};

export const make = Effect.gen(function* () {
  const fleetRegistry = yield* FleetRegistry;
  const reconciler = yield* FleetReconciler;

  const list: PeerRegistryShape["list"] = fleetRegistry.snapshot.pipe(
    Effect.map((roster) =>
      roster.members.flatMap((member) => {
        const peer = peerFromMember(member);
        return peer === null ? [] : [peer];
      }),
    ),
    Effect.mapError(mapFleetStateError),
    Effect.withSpan("PeerRegistry.list"),
  );

  const resolve: PeerRegistryShape["resolve"] = Effect.fn("PeerRegistry.resolve")(function* (name) {
    const resolved = yield* fleetRegistry
      .resolveByName(name)
      .pipe(Effect.mapError(mapFleetStateError));
    if (Option.isNone(resolved)) return Option.none<ResolvedPeer>();
    const peer = peerFromResolved(resolved.value);
    return peer === null
      ? Option.none<ResolvedPeer>()
      : Option.some({ peer, credential: resolved.value.credential });
  });

  const register: PeerRegistryShape["register"] = Effect.fn("PeerRegistry.register")(
    function* (input) {
      const result = yield* reconciler
        .register({
          name: input.name,
          baseUrl: input.baseUrl,
          credential: input.credential,
          ...(input.sshUser === undefined ? {} : { sshUser: input.sshUser }),
        })
        .pipe(
          Effect.mapError((cause) =>
            isFleetRegistrationError(cause)
              ? new PeerRegistrationError({
                  reason: mapRegistrationReason(cause.reason),
                  name: cause.name,
                  ...(cause.detail === undefined ? {} : { detail: cause.detail }),
                })
              : mapFleetStateError(cause),
          ),
        );
      const roster = result.roster;
      const member = roster.members.find(
        (candidate) => candidate.node.environmentId === result.node.environmentId,
      );
      const peer = member === undefined ? null : peerFromMember(member);
      if (peer === null) {
        return yield* new PeerRegistryStateError({
          operation: "load",
          cause: "Registered fleet member has no advertised endpoint.",
        });
      }
      return peer;
    },
  );

  const remove: PeerRegistryShape["remove"] = Effect.fn("PeerRegistry.remove")(function* (name) {
    const roster = yield* fleetRegistry.snapshot.pipe(Effect.mapError(mapFleetStateError));
    const member = roster.members.find((candidate) => candidate.node.name === name);
    if (member === undefined) return false;
    const now = DateTime.formatIso(yield* DateTime.now);
    const result = yield* reconciler
      .remove(member.node.environmentId, now)
      .pipe(Effect.mapError(mapFleetStateError));
    return result.removed;
  });

  const setSshUser: PeerRegistryShape["setSshUser"] = Effect.fn("PeerRegistry.setSshUser")(
    function* (name, sshUser) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* fleetRegistry
        .setSshUser(name, sshUser, now)
        .pipe(Effect.mapError(mapFleetStateError));
    },
  );

  return PeerRegistry.of({ list, register, remove, resolve, setSshUser });
});

export const layer = Layer.effect(PeerRegistry, make);
