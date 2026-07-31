import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  isTailscaleIpv4Address,
  readRawTailscaleStatus,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const RawTailscaleUser = Schema.Struct({
  ID: Schema.Number,
  LoginName: Schema.String,
  DisplayName: Schema.String,
  ProfilePicURL: Schema.optional(Schema.String),
});

const RawTailscalePeer = Schema.Struct({
  ID: Schema.String,
  PublicKey: Schema.String,
  HostName: Schema.String,
  DNSName: Schema.String,
  OS: Schema.String,
  UserID: Schema.Number,
  TailscaleIPs: Schema.Array(Schema.String),
  Online: Schema.Boolean,
  Active: Schema.Boolean,
  KeyExpiry: Schema.optional(Schema.String),
  LastSeen: Schema.optional(Schema.String),
  sshHostKeys: Schema.optional(Schema.Array(Schema.String)),
});

const RawCurrentTailnet = Schema.Struct({
  Name: Schema.String,
  MagicDNSSuffix: Schema.String,
  MagicDNSEnabled: Schema.Boolean,
});

/**
 * The fields below mirror the stable portions of `tailscale status --json`.
 * `Peer` and `User` are objects keyed by node/public key and numeric user ID,
 * respectively; they are not arrays.
 */
export const TailscalePeerStatusPayload = Schema.Struct({
  Version: Schema.optional(Schema.String),
  BackendState: Schema.optional(Schema.String),
  MagicDNSSuffix: Schema.optional(Schema.String),
  CurrentTailnet: Schema.optional(RawCurrentTailnet),
  Peer: Schema.optional(
    Schema.Union([Schema.Record(Schema.String, RawTailscalePeer), Schema.Null]),
  ),
  User: Schema.optional(
    Schema.Union([Schema.Record(Schema.String, RawTailscaleUser), Schema.Null]),
  ),
});
export type TailscalePeerStatusPayload = typeof TailscalePeerStatusPayload.Type;

export interface TailscalePeerUser {
  readonly id: number;
  readonly loginName: string;
  readonly displayName: string;
  readonly profilePictureUrl: string | null;
}

export interface TailscalePeer {
  /** Key used for this peer in the status JSON `Peer` object. */
  readonly statusKey: string;
  readonly id: string;
  readonly publicKey: string;
  readonly hostname: string;
  readonly dnsName: string | null;
  readonly os: string;
  readonly userId: number;
  readonly user: TailscalePeerUser | null;
  readonly addresses: readonly string[];
  readonly tailnetIpv4Addresses: readonly string[];
  readonly online: boolean;
  readonly active: boolean;
  readonly lastSeen: string | null;
  readonly keyExpiry: string | null;
  readonly sshHostKeys: readonly string[];
}

export interface TailscalePeerDiscovery {
  readonly clientVersion: string | null;
  readonly backendState: string | null;
  readonly magicDnsSuffix: string | null;
  readonly tailnet: {
    readonly name: string;
    readonly magicDnsSuffix: string;
    readonly magicDnsEnabled: boolean;
  } | null;
  readonly peers: readonly TailscalePeer[];
}

const decodeTailscalePeerStatusPayload = Schema.decodeEffect(
  Schema.fromJsonString(TailscalePeerStatusPayload),
);

function normalizeDnsName(input: string): string | null {
  const normalized = input.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalString(input: string | undefined): string | null {
  if (input === undefined) {
    return null;
  }
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolvePeerUser(
  users: Readonly<Record<string, typeof RawTailscaleUser.Type>> | null | undefined,
  userId: number,
): TailscalePeerUser | null {
  const rawUser = users?.[String(userId)];
  return rawUser
    ? {
        id: rawUser.ID,
        loginName: rawUser.LoginName,
        displayName: rawUser.DisplayName,
        profilePictureUrl: normalizeOptionalString(rawUser.ProfilePicURL),
      }
    : null;
}

export const parseTailscalePeerDiscovery = Effect.fn("tailscale.peers.parseTailscalePeerDiscovery")(
  function* (
    rawStatusJson: string,
  ): Effect.fn.Return<TailscalePeerDiscovery, TailscaleStatusParseError> {
    const payload = yield* decodeTailscalePeerStatusPayload(rawStatusJson).pipe(
      Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    );
    const users = payload.User;
    const peers = Object.entries(payload.Peer ?? {}).map(([statusKey, peer]) => {
      const addresses = peer.TailscaleIPs.map((address) => address.trim()).filter(
        (address) => address.length > 0,
      );
      return {
        statusKey,
        id: peer.ID,
        publicKey: peer.PublicKey,
        hostname: peer.HostName,
        dnsName: normalizeDnsName(peer.DNSName),
        os: peer.OS,
        userId: peer.UserID,
        user: resolvePeerUser(users, peer.UserID),
        addresses,
        tailnetIpv4Addresses: addresses.filter(isTailscaleIpv4Address),
        online: peer.Online,
        active: peer.Active,
        lastSeen: normalizeOptionalString(peer.LastSeen),
        keyExpiry: normalizeOptionalString(peer.KeyExpiry),
        sshHostKeys: peer.sshHostKeys ?? [],
      } satisfies TailscalePeer;
    });

    peers.sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.hostname.localeCompare(right.hostname);
    });

    return {
      clientVersion: normalizeOptionalString(payload.Version),
      backendState: normalizeOptionalString(payload.BackendState),
      magicDnsSuffix: normalizeOptionalString(payload.MagicDNSSuffix),
      tailnet: payload.CurrentTailnet
        ? {
            name: payload.CurrentTailnet.Name,
            magicDnsSuffix: payload.CurrentTailnet.MagicDNSSuffix,
            magicDnsEnabled: payload.CurrentTailnet.MagicDNSEnabled,
          }
        : null,
      peers,
    };
  },
);

export const discoverTailscalePeers = readRawTailscaleStatus.pipe(
  Effect.flatMap(parseTailscalePeerDiscovery),
);
