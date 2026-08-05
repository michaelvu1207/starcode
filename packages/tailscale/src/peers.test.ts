// @effect-diagnostics preferSchemaOverJson:off - fixtures intentionally mirror raw CLI JSON.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseTailscalePeerDiscovery } from "./peers.ts";
import { TailscaleStatusParseError } from "./tailscale.ts";

const actualStatusShape = JSON.stringify({
  Version: "1.84.1-t123",
  TUN: true,
  BackendState: "Running",
  HaveNodeKey: true,
  AuthURL: "",
  TailscaleIPs: ["100.90.0.1", "fd7a:115c:a1e0::1"],
  Self: {
    ID: "self-id",
    PublicKey: "nodekey:self",
    HostName: "local",
    DNSName: "local.example.ts.net.",
    OS: "macOS",
    UserID: 1,
    TailscaleIPs: ["100.90.0.1"],
    Online: true,
    Active: false,
  },
  Health: [],
  MagicDNSSuffix: "example.ts.net",
  CurrentTailnet: {
    Name: "example.com",
    MagicDNSSuffix: "example.ts.net",
    MagicDNSEnabled: true,
  },
  CertDomains: ["local.example.ts.net"],
  Peer: {
    "nodekey:offline": {
      ID: "peer-offline",
      PublicKey: "nodekey:offline",
      HostName: "zeta",
      DNSName: "",
      OS: "linux",
      UserID: 42,
      TailscaleIPs: ["100.101.1.2"],
      AllowedIPs: ["100.101.1.2/32"],
      Addrs: null,
      CurAddr: "",
      Relay: "lax",
      RxBytes: 0,
      TxBytes: 0,
      Created: "2026-01-01T00:00:00Z",
      LastWrite: "2026-01-01T00:00:00Z",
      LastSeen: "2026-01-02T00:00:00Z",
      LastHandshake: "2026-01-01T00:00:00Z",
      Online: false,
      ExitNode: false,
      ExitNodeOption: false,
      Active: false,
      PeerAPIURL: [],
      InNetworkMap: true,
      InMagicSock: true,
      InEngine: false,
      KeyExpiry: "2027-01-01T00:00:00Z",
    },
    "nodekey:online": {
      ID: "peer-online",
      PublicKey: "nodekey:online",
      HostName: "alpha",
      DNSName: "alpha.example.ts.net.",
      OS: "windows",
      UserID: 42,
      TailscaleIPs: ["100.100.1.2", "fd7a:115c:a1e0::2", "192.168.0.2"],
      AllowedIPs: ["100.100.1.2/32"],
      Addrs: ["100.64.0.1:1234"],
      CurAddr: "100.64.0.1:1234",
      Relay: "sea",
      RxBytes: 12,
      TxBytes: 34,
      Created: "2026-01-01T00:00:00Z",
      LastWrite: "2026-01-03T00:00:00Z",
      LastSeen: "2026-01-03T00:00:00Z",
      LastHandshake: "2026-01-03T00:00:00Z",
      Online: true,
      ExitNode: false,
      ExitNodeOption: false,
      Active: true,
      PeerAPIURL: ["http://100.100.1.2:1"],
      InNetworkMap: true,
      InMagicSock: true,
      InEngine: true,
      KeyExpiry: "2027-01-01T00:00:00Z",
      sshHostKeys: ["ssh-ed25519 AAAA"],
    },
  },
  User: {
    "42": {
      ID: 42,
      LoginName: "operator@example.com",
      DisplayName: "Operator",
      ProfilePicURL: "https://example.com/profile.png",
    },
  },
  ClientVersion: null,
});

describe("tailscale peer discovery", () => {
  it.effect("parses the object-keyed peer and user shapes emitted by tailscale status", () =>
    Effect.gen(function* () {
      const discovery = yield* parseTailscalePeerDiscovery(actualStatusShape);

      assert.equal(discovery.clientVersion, "1.84.1-t123");
      assert.equal(discovery.backendState, "Running");
      assert.deepEqual(discovery.tailnet, {
        name: "example.com",
        magicDnsSuffix: "example.ts.net",
        magicDnsEnabled: true,
      });
      assert.equal(discovery.peers.length, 2);
      assert.equal(discovery.peers[0]?.hostname, "alpha");
      assert.equal(discovery.peers[0]?.dnsName, "alpha.example.ts.net");
      assert.deepEqual(discovery.peers[0]?.tailnetIpv4Addresses, ["100.100.1.2"]);
      assert.deepEqual(discovery.peers[0]?.sshHostKeys, ["ssh-ed25519 AAAA"]);
      assert.deepEqual(discovery.peers[0]?.user, {
        id: 42,
        loginName: "operator@example.com",
        displayName: "Operator",
        profilePictureUrl: "https://example.com/profile.png",
      });
      assert.equal(discovery.peers[1]?.dnsName, null);
      assert.equal(discovery.peers[1]?.online, false);
    }),
  );

  it.effect("accepts a logged-in status with no peers", () =>
    Effect.gen(function* () {
      const discovery = yield* parseTailscalePeerDiscovery(
        JSON.stringify({
          Version: "1.84.1",
          BackendState: "Running",
          MagicDNSSuffix: "example.ts.net",
          Peer: null,
          User: {},
        }),
      );

      assert.deepEqual(discovery.peers, []);
      assert.equal(discovery.tailnet, null);
    }),
  );

  it.effect("rejects malformed peer facts instead of silently inventing defaults", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscalePeerDiscovery(
        JSON.stringify({
          Peer: {
            "nodekey:broken": {
              ID: "broken",
              Online: "yes",
            },
          },
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, TailscaleStatusParseError);
    }),
  );
});
