import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, FleetNodeName, type FleetMember } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { FleetRegistry, fleetNodeSecretName, layer } from "./FleetRegistry.ts";

const makeLayer = () =>
  layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "starcode-fleet-registry-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const legacyPeerSecretName = (name: string): string =>
  `peer-${Buffer.from(name, "utf8").toString("base64url")}`;

const member = (name: string, updatedAt: string): FleetMember => {
  const environmentId = EnvironmentId.make(name);
  return {
    node: {
      environmentId,
      name: FleetNodeName.make(name),
      label: name.toUpperCase(),
      platform: { os: "linux", arch: "x64" },
      endpoints: [
        {
          id: "manual",
          label: "Manual",
          provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
          httpBaseUrl: `http://${name}.test/`,
          wsBaseUrl: `ws://${name}.test/`,
          reachability: "private-network",
          compatibility: {
            hostedHttpsApp: "mixed-content-blocked",
            desktopApp: "compatible",
          },
          source: "user",
          status: "available",
          isDefault: true,
        },
      ],
      sshUser: null,
      updatedAt,
    },
    registeredAt: updatedAt,
    updatedAt,
  };
};

it.effect("keeps credentials out of fleet.json and removes them with a tombstone", () =>
  Effect.gen(function* () {
    const registry = yield* FleetRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const gamma = member("gamma", "2026-07-30T00:00:00.000Z");
    yield* registry.upsert(gamma, "administrative-secret-value");

    const document = yield* fs.readFileString(config.fleetPath);
    assert.notInclude(document, "administrative-secret-value");
    assert.notInclude(document, "credentialClass");
    assert.isTrue(Option.isSome(yield* registry.resolveByEnvironmentId(gamma.node.environmentId)));

    const removed = yield* registry.remove(gamma.node.environmentId, "2026-07-30T01:00:00.000Z");
    assert.isTrue(removed.removed);
    assert.isTrue(Option.isNone(yield* registry.resolveByEnvironmentId(gamma.node.environmentId)));
    assert.deepEqual(
      removed.roster.tombstones.map((entry) => entry.environmentId),
      ["gamma"],
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps an identical upsert revision-stable while rotating its credential", () =>
  Effect.gen(function* () {
    const registry = yield* FleetRegistry;
    const gamma = member("gamma", "2026-07-30T00:00:00.000Z");
    const first = yield* registry.upsert(gamma, "first-credential");
    const second = yield* registry.upsert(gamma, "second-credential");
    const resolved = yield* registry.resolveByEnvironmentId(gamma.node.environmentId);

    assert.equal(second.revision, first.revision);
    assert.equal(Option.getOrThrow(resolved).credential, "second-credential");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("does not promote a legacy read-only credential to fleet administration", () =>
  Effect.gen(function* () {
    const registry = yield* FleetRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environmentId = EnvironmentId.make("legacy-read-only");

    yield* fs.writeFileString(
      config.peersPath,
      `{
  "version": 1,
  "peers": [{
    "name": "legacy-read-only",
    "baseUrl": "http://legacy-read-only.test",
    "environmentId": "legacy-read-only",
    "label": "Legacy read only",
    "scopes": ["orchestration:read"],
    "registeredAt": "2026-07-30T00:00:00.000Z",
    "credentialExpiresAt": "2026-08-30T00:00:00.000Z"
  }]
}
`,
    );
    yield* secrets.set(
      legacyPeerSecretName("legacy-read-only"),
      new TextEncoder().encode("legacy-read-only-secret"),
    );

    const migrated = yield* registry.snapshot;

    assert.deepEqual(migrated.members, []);
    assert.isTrue(Option.isNone(yield* registry.resolveByEnvironmentId(environmentId)));
    assert.isFalse(yield* fs.exists(config.peersPath));
    assert.isTrue(Option.isNone(yield* secrets.get(legacyPeerSecretName("legacy-read-only"))));
    assert.isTrue(Option.isNone(yield* secrets.get(fleetNodeSecretName(environmentId))));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("migrates only an unexpired administrative legacy credential", () =>
  Effect.gen(function* () {
    const registry = yield* FleetRegistry;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environmentId = EnvironmentId.make("legacy-administrative");

    yield* fs.writeFileString(
      config.peersPath,
      `{
  "version": 1,
  "peers": [{
    "name": "legacy-administrative",
    "baseUrl": "http://legacy-administrative.test",
    "environmentId": "legacy-administrative",
    "label": "Legacy administrative",
    "scopes": [
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write"
    ],
    "registeredAt": "2026-07-30T00:00:00.000Z",
    "credentialExpiresAt": "2099-08-30T00:00:00.000Z"
  }]
}
`,
    );
    yield* secrets.set(
      legacyPeerSecretName("legacy-administrative"),
      new TextEncoder().encode("legacy-administrative-secret"),
    );

    const migrated = yield* registry.snapshot;
    const resolved = yield* registry.resolveByEnvironmentId(environmentId);

    assert.deepEqual(
      migrated.members.map((entry) => entry.node.environmentId),
      [environmentId],
    );
    assert.equal(Option.getOrThrow(resolved).credential, "legacy-administrative-secret");
    assert.isFalse(yield* fs.exists(config.peersPath));
    assert.isTrue(Option.isNone(yield* secrets.get(legacyPeerSecretName("legacy-administrative"))));
  }).pipe(Effect.provide(makeLayer())),
);
