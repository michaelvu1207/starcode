import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId, ThreadId } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { FleetSessionBootstrap } from "../FleetSessionBootstrap.ts";
import { PiDriver } from "./PiDriver.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

it.effect("wires FleetSessionBootstrap.snapshot through PiDriver into PiAdapter", () => {
  const requestedThreads: Array<ThreadId> = [];
  const threadId = ThreadId.make("pi-driver-bootstrap");
  const bootstrap = FleetSessionBootstrap.of({
    snapshot: ({ threadId: requestedThreadId }) =>
      Effect.sync(() => {
        requestedThreads.push(requestedThreadId);
        return undefined;
      }),
  });
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "starcode-pi-driver-bootstrap-test-",
  }).pipe(Layer.provideMerge(NodeServices.layer));

  return Effect.scoped(
    Effect.gen(function* () {
      const instance = yield* PiDriver.create({
        instanceId: ProviderInstanceId.make("pi-bootstrap-test"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: decodePiSettings({}),
      });

      // Session startup may stop later on model or MCP configuration in this
      // isolated fixture. The composition invariant is that the fleet
      // snapshot was requested first through the production adapter closure.
      yield* instance.adapter
        .startSession({
          threadId,
          providerInstanceId: instance.instanceId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.deepEqual(requestedThreads, [threadId]);
    }),
  ).pipe(
    Effect.provideService(FleetSessionBootstrap, bootstrap),
    Effect.provide(serverConfigLayer),
  );
});
