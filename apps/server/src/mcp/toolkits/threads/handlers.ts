/**
 * Handler for `thread_create`.
 *
 * Thin on purpose: the argument checking that is genuinely about the *call*
 * lives here, and everything about where a thread lands and what it starts as
 * lives in `LocalThreadWriter`, so the rules stay testable without an MCP
 * session standing behind them.
 *
 * @module ThreadHandlers
 */
import { ThreadToolError } from "@starcode/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LocalThreadWriter } from "../../../threads/LocalThreadWriter.ts";
import { ThreadsToolkit } from "./tools.ts";

/**
 * The base capability every session holds.
 *
 * It is spelled `peers` even though this tool never leaves the machine, and that
 * is not a leftover: the capability answers "may this session act on the thread
 * graph", and starting a thread here is the same kind of act as messaging one
 * over there. Splitting it would mean minting a second capability that is
 * granted to exactly the same sessions, in exactly the same places, forever.
 *
 * There is no operate-level check, and that absence is the feature: a worker
 * that cannot start its own helper is amputated the same way one that could not
 * message a sibling would be. This check only fires for a credential minted
 * without the base set at all — a shape that should not occur — so it fails
 * loudly rather than quietly starting a thread for a session with no standing.
 */
const requireThreadsCapability = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("peers")) {
    return yield* new ThreadToolError({
      operation: "create",
      reason: "capability_unavailable",
      detail:
        "This MCP credential does not grant the peers capability, which every session that may act on threads holds.",
    });
  }
  return invocation;
});

const handlers = {
  thread_create: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireThreadsCapability;
      // Exactly one way of saying where, refused rather than resolved by
      // precedence — the same call `peer_thread_create` makes, for the same
      // reason: an agent that passed both believes something about this call,
      // and honouring one of them silently would let that belief stay wrong.
      if ((input.project === undefined) === (input.projectId === undefined)) {
        return yield* new ThreadToolError({
          operation: "create",
          reason: "project_not_found",
          detail:
            input.project === undefined
              ? "Say where the thread goes: pass project (a slug, as project_list reports it) or projectId (this machine's own folder id)."
              : "Pass project or projectId, not both — they can name different folders.",
        });
      }
      const writer = yield* LocalThreadWriter;
      return yield* writer.createThread({
        callerThreadId: invocation.threadId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.project === undefined ? {} : { project: input.project }),
        title: input.title,
        message: input.message,
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      });
    }),
} satisfies Parameters<typeof ThreadsToolkit.toLayer>[0];

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(handlers);
