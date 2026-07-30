import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { PeerName } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  judgePeerScopes,
  normalizePeerBaseUrl,
  peerCredentialScopes,
} from "./PeerEnvironmentClient.ts";
import * as PeerRegistry from "./PeerRegistry.ts";

const makePeerRegistryLayer = () =>
  PeerRegistry.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "starcode-peer-registry-test-" }),
      ),
    ),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("reports no peers before anything is registered", () =>
  Effect.gen(function* () {
    const registry = yield* PeerRegistry.PeerRegistry;

    assert.deepEqual([...(yield* registry.list)], []);
    assert.isTrue(Option.isNone(yield* registry.resolve(PeerName.make("absent"))));
  }).pipe(Effect.provide(makePeerRegistryLayer())),
);

it.effect("refuses a base URL that is not an absolute http(s) origin", () =>
  Effect.gen(function* () {
    const registry = yield* PeerRegistry.PeerRegistry;

    const error = yield* registry
      .register({
        name: PeerName.make("bad"),
        baseUrl: "file:///etc/passwd",
        credential: { pairingToken: "irrelevant" },
      })
      .pipe(Effect.flip);

    assert.isTrue(error._tag === "PeerRegistrationError" && error.reason === "invalid_base_url");
    // The rejection happens before any network call, so nothing is persisted.
    assert.deepEqual([...(yield* registry.list)], []);
  }).pipe(Effect.provide(makePeerRegistryLayer())),
);

it.effect("refuses a direct token before it can be stored when the peer is unreachable", () =>
  Effect.gen(function* () {
    const registry = yield* PeerRegistry.PeerRegistry;

    const error = yield* registry
      .register({
        name: PeerName.make("offline"),
        // Reserved by RFC 5737 for documentation; never routable.
        baseUrl: "http://192.0.2.1:9",
        credential: { token: "some-bearer-token" },
      })
      .pipe(Effect.flip);

    assert.isTrue(error._tag === "PeerRegistrationError" && error.reason === "peer_unreachable");
    assert.deepEqual([...(yield* registry.list)], []);
  }).pipe(Effect.provide(makePeerRegistryLayer())),
);

it.effect("removing an unknown peer reports no change and writes no state", () =>
  Effect.gen(function* () {
    const registry = yield* PeerRegistry.PeerRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    assert.isFalse(yield* registry.remove(PeerName.make("absent")));
    assert.isFalse(yield* fileSystem.exists(config.peersPath));
  }).pipe(Effect.provide(makePeerRegistryLayer())),
);

it("normalizes a peer base URL to its origin and rejects other schemes", () => {
  assert.equal(
    normalizePeerBaseUrl("  http://127.0.0.1:14233/some/path?x=1 "),
    "http://127.0.0.1:14233",
  );
  assert.equal(normalizePeerBaseUrl("https://peer.example.com"), "https://peer.example.com");
  assert.equal(normalizePeerBaseUrl("file:///etc/passwd"), null);
  assert.equal(normalizePeerBaseUrl("starcode://app"), null);
  assert.equal(normalizePeerBaseUrl("127.0.0.1:14233"), null);
  assert.equal(normalizePeerBaseUrl("not a url"), null);
});

describe("peer credential classes", () => {
  it("accepts a read peer holding exactly the read scope", () => {
    assert.deepStrictEqual(judgePeerScopes("read", ["orchestration:read"]), { ok: true });
  });

  it("accepts an operate peer holding read plus operate", () => {
    assert.deepStrictEqual(
      judgePeerScopes("operate", ["orchestration:read", "orchestration:operate"]),
      { ok: true },
    );
  });

  it("refuses an operate peer that was only granted read", () => {
    const verdict = judgePeerScopes("operate", ["orchestration:read"]);
    assert.isFalse(verdict.ok);
    assert.strictEqual(verdict.ok === false ? verdict.reason : null, "scope_not_granted");
  });

  it("refuses a read peer handed an operate-capable token", () => {
    // The point of the class: a read registration must not quietly end up
    // holding write authority over another machine.
    const verdict = judgePeerScopes("read", ["orchestration:read", "orchestration:operate"]);
    assert.isFalse(verdict.ok);
    assert.strictEqual(verdict.ok === false ? verdict.reason : null, "scope_too_broad");
  });

  it("refuses an operate peer handed an administrative token", () => {
    const verdict = judgePeerScopes("operate", [
      "orchestration:read",
      "orchestration:operate",
      "access:write",
    ]);
    assert.isFalse(verdict.ok);
    assert.strictEqual(verdict.ok === false ? verdict.reason : null, "scope_too_broad");
  });

  it("refuses a credential that grants nothing at all", () => {
    const verdict = judgePeerScopes("read", []);
    assert.isFalse(verdict.ok);
    assert.strictEqual(verdict.ok === false ? verdict.reason : null, "scope_not_granted");
  });

  it("keeps read-class registrations unchanged from F2", () => {
    assert.deepStrictEqual([...peerCredentialScopes("read")], ["orchestration:read"]);
  });
});

it.effect("recording an ssh login for an unknown peer reports no change", () =>
  Effect.gen(function* () {
    const registry = yield* PeerRegistry.PeerRegistry;

    // Its own operation rather than a re-register precisely so it cannot create
    // a peer as a side effect — an unknown name is a no-op, not an insert.
    assert.isFalse(yield* registry.setSshUser(PeerName.make("absent"), "someone"));
    assert.deepEqual([...(yield* registry.list)], []);
  }).pipe(Effect.provide(makePeerRegistryLayer())),
);
