import { WS_METHODS } from "@starcode/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

export function createMessageSimplificationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    simplify: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:message:simplify",
      tag: WS_METHODS.messageSimplify,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.messageId]),
      },
    }),
  };
}
