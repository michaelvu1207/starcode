import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@starcode/contracts";
import * as Effect from "effect/Effect";

import { FleetSessionBootstrap } from "../FleetSessionBootstrap.ts";
import { makeClaudeDriverAdapterOptions } from "./ClaudeDriver.ts";
import { makeCodexDriverAdapterOptions } from "./CodexDriver.ts";

it.effect("passes the production fleet bootstrap provider through Claude and Codex drivers", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-driver-bootstrap");
    const snapshot = {
      localNode: {
        environmentId: EnvironmentId.make("environment-local"),
        label: "MacBook Pro",
      },
      reachableNodes: [],
      thread: {
        threadId,
        title: "Driver bootstrap",
      },
      orchestrator: {
        role: "worker" as const,
      },
    };
    const fleetSessionBootstrap = FleetSessionBootstrap.of({
      snapshot: () => Effect.succeed(snapshot),
    });
    const input = {
      instanceId: ProviderInstanceId.make("provider-test"),
      environment: { STARCODE_TEST: "true" },
      fleetSessionBootstrap,
    };

    const claudeOptions = makeClaudeDriverAdapterOptions(input);
    const codexOptions = makeCodexDriverAdapterOptions(input);

    NodeAssert.strictEqual(
      claudeOptions.fleetSessionBootstrapSnapshot,
      fleetSessionBootstrap.snapshot,
    );
    NodeAssert.strictEqual(
      codexOptions.fleetSessionBootstrapSnapshot,
      fleetSessionBootstrap.snapshot,
    );
    NodeAssert.deepStrictEqual(
      yield* claudeOptions.fleetSessionBootstrapSnapshot!({ threadId }),
      snapshot,
    );
    NodeAssert.deepStrictEqual(
      yield* codexOptions.fleetSessionBootstrapSnapshot!({ threadId }),
      snapshot,
    );
  }),
);
