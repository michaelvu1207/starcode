/**
 * Decoding guarantees for the peer registry file.
 *
 * These are backward-compatibility tests, not shape tests. Every `peers.json`
 * on every machine in the fleet was written before `sshUser` existed, and the
 * registry decodes the whole file at once — so a field that failed to default
 * would not degrade one peer, it would take the entire registry down and with
 * it every federation tool.
 */
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PeerEnvironment } from "./peers.ts";

const decode = Schema.decodeUnknownEffect(PeerEnvironment);

/** Exactly the shape a pre-sshUser server wrote, field for field. */
const legacyPeer = {
  name: "simforgelaptop",
  baseUrl: "http://100.124.216.23:3773",
  environmentId: "ca459883-ee24-4a21-94a0-9a8c4b9a4c92",
  label: "Michael's MacBook Pro",
  scopes: ["orchestration:read"],
  registeredAt: "2026-07-25T01:52:38.135Z",
  credentialExpiresAt: "2026-08-24T01:38:07.809Z",
};

it.effect("decodes a peers.json entry written before sshUser existed", () =>
  Effect.gen(function* () {
    const peer = yield* decode(legacyPeer);
    expect(peer.sshUser).toBeNull();
    // The neighbouring default must not have regressed either: an entry with no
    // credentialClass is a read peer, never an operate one.
    expect(peer.credentialClass).toBe("read");
  }),
);

it.effect("round-trips a recorded ssh login", () =>
  Effect.gen(function* () {
    const peer = yield* decode({ ...legacyPeer, sshUser: "michaelvu-simforge" });
    expect(peer.sshUser).toBe("michaelvu-simforge");
  }),
);

it.effect("keeps an explicitly cleared login as null rather than dropping the key", () =>
  Effect.gen(function* () {
    const peer = yield* decode({ ...legacyPeer, sshUser: null });
    expect(peer.sshUser).toBeNull();
  }),
);
