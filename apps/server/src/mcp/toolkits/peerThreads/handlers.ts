import {
  PeerFederationError,
  type PeerFederationOperation,
  type ThreadMailboxOrigin,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerThreadReader from "../../../peers/PeerThreadReader.ts";
import * as PeerThreadWriter from "../../../peers/PeerThreadWriter.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
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

/**
 * The master gate. Note that this is the *second* line of defence, not the
 * first: a non-master session's credential never carries `peers-operate` at
 * all, so this check only fires for a token that was somehow minted with it and
 * then reused. Keeping it means the invariant is stated in the code path that
 * depends on it, rather than only in the mint site.
 */
const requireOperateCapability = (operation: PeerFederationOperation) =>
  requirePeerCapability(operation).pipe(
    Effect.flatMap((invocation) =>
      invocation.capabilities.has("peers-operate")
        ? Effect.succeed(invocation)
        : new PeerFederationError({
            operation,
            reason: "capability_unavailable",
            detail:
              "Only the designated workbench master thread may create or interrupt threads. Use peer_thread_send to leave a message instead.",
          }),
    ),
  );

/**
 * Builds the provenance stamped onto an outgoing message. Every field is
 * resolved from server state rather than accepted from the tool call, so a
 * sending agent cannot claim to be a thread it is not.
 */
const resolveOrigin = (invocation: McpInvocationContext.McpInvocationScope) =>
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const descriptor = yield* environment.getDescriptor.pipe(
      Effect.map(Option.some),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
    return {
      environmentId: invocation.environmentId,
      environmentLabel: Option.match(descriptor, {
        onNone: () => null,
        onSome: (value) => value.label,
      }),
      threadId: invocation.threadId,
      threadTitle: Option.match(thread, {
        onNone: () => null,
        onSome: (value) => value.title,
      }),
    } satisfies ThreadMailboxOrigin;
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
  peer_thread_send: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requirePeerCapability("send");
      const origin = yield* resolveOrigin(invocation);
      const writer = yield* PeerThreadWriter.PeerThreadWriter;
      return yield* writer.sendMessage({
        ...(input.peer === undefined ? {} : { peer: input.peer }),
        threadId: input.threadId,
        message: input.message,
        origin,
      });
    }),
  peer_thread_create: (input) =>
    Effect.gen(function* () {
      yield* requireOperateCapability("create");
      const writer = yield* PeerThreadWriter.PeerThreadWriter;
      return yield* writer.createThread({
        peer: input.peer,
        projectId: input.projectId,
        title: input.title,
        message: input.message,
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      });
    }),
  peer_thread_dispatch: (input) =>
    Effect.gen(function* () {
      yield* requireOperateCapability("dispatch");
      const writer = yield* PeerThreadWriter.PeerThreadWriter;
      return yield* writer.dispatchThread({
        peer: input.peer,
        threadId: input.threadId,
        message: input.message,
      });
    }),
} satisfies Parameters<typeof PeerThreadsToolkit.toLayer>[0];

export const PeerThreadsToolkitHandlersLive = PeerThreadsToolkit.toLayer(handlers);
