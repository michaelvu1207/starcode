/**
 * The master gate, tested at the seam that actually enforces it.
 *
 * The invariant under test is not "the tool handler refuses" — it is that a
 * session which is not the designated master never receives a credential
 * carrying `peers-operate` in the first place. That is what makes the gate
 * structural rather than a check an agent could get around.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { __testing } from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const masterThreadId = ThreadId.make("thread-master");
const workerThreadId = ThreadId.make("thread-worker");

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
} as unknown as HttpServer.HttpServer["Service"]);

const environmentLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(environmentId),
});

/** Issues a credential for one thread against a server configured as given. */
const capabilitiesFor = (threadId: ThreadId, configuredMaster: string) =>
  Effect.gen(function* () {
    const registry = yield* __testing.make({ now: () => 1_000 });
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const scope = yield* registry.resolve(issued.config.authorizationHeader.replace("Bearer ", ""));
    return [...(scope?.capabilities ?? [])].toSorted();
  }).pipe(
    Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
    Effect.provide(
      Layer.mergeAll(
        environmentLayer,
        serverSettingsLayerTest({ workbenchMasterThreadId: configuredMaster }),
        NodeServices.layer,
      ),
    ),
  );

describe("workbench master gating", () => {
  it.effect("withholds peers-operate from an ordinary session", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(workerThreadId, masterThreadId);
      assert.deepStrictEqual(capabilities, ["peers", "preview"]);
      assert.notInclude(capabilities, "peers-operate");
    }),
  );

  it.effect("grants peers-operate to the designated master session", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(masterThreadId, masterThreadId);
      assert.deepStrictEqual(capabilities, ["peers", "peers-operate", "preview"]);
    }),
  );

  it.effect("grants nothing extra when no master is designated", () =>
    Effect.gen(function* () {
      // The unconfigured state is every server's default, so an empty setting
      // must never be read as "every thread is the master".
      const capabilities = yield* capabilitiesFor(masterThreadId, "");
      assert.deepStrictEqual(capabilities, ["peers", "preview"]);
    }),
  );

  it.effect("still gives every session the read and mailbox capability", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(workerThreadId, masterThreadId);
      assert.include(capabilities, "peers");
    }),
  );

  it.effect("tolerates whitespace around a configured thread id", () =>
    Effect.gen(function* () {
      const capabilities = yield* capabilitiesFor(masterThreadId, `  ${masterThreadId}  `);
      assert.include(capabilities, "peers-operate");
    }),
  );
});
