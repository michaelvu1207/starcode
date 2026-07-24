import { PeerFederationError, type PeerFederationOperation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerThreadReader from "../../../peers/PeerThreadReader.ts";
import { PeerThreadsToolkit } from "./tools.ts";

/**
 * Mirrors `requireMcpCapability`, but fails with the federation error type so
 * the peer tools never surface a preview-shaped error to an agent.
 */
const requirePeerCapability = (operation: PeerFederationOperation) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("peers")) {
      return yield* new PeerFederationError({
        operation,
        reason: "capability_unavailable",
        detail: "This MCP credential does not grant the peers capability.",
      });
    }
    return invocation;
  });

const handlers = {
  peer_threads_list: (input) =>
    requirePeerCapability("list").pipe(
      Effect.andThen(() => PeerThreadReader.PeerThreadReader),
      Effect.flatMap((reader) =>
        reader.listThreads({
          ...(input.peer === undefined ? {} : { peer: input.peer }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.order === undefined ? {} : { order: input.order }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
      ),
    ),
  peer_thread_read: (input) =>
    requirePeerCapability("read").pipe(
      Effect.andThen(() => PeerThreadReader.PeerThreadReader),
      Effect.flatMap((reader) =>
        reader.readThread({
          peer: input.peer,
          threadId: input.threadId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.before === undefined ? {} : { before: input.before }),
        }),
      ),
    ),
} satisfies Parameters<typeof PeerThreadsToolkit.toLayer>[0];

export const PeerThreadsToolkitHandlersLive = PeerThreadsToolkit.toLayer(handlers);
