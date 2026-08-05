/**
 * One-release compatibility aliases for the canonical thread toolkit.
 *
 * The alias handlers only translate old peer-shaped inputs and outputs. All
 * authorization, project scoping, provenance, validation and routing stays in
 * the canonical operations so the deprecated names cannot drift.
 *
 * @module PeerThreadHandlers
 */
import { PeerFederationError, PeerName } from "@starcode/contracts";
import * as Effect from "effect/Effect";

import { PeerRegistry } from "../../../peers/PeerRegistry.ts";
import { permitsThreadOperation } from "../../../threads/ThreadCapability.ts";
import { requireThreadsCapability, threadToolOperations } from "../threads/handlers.ts";
import { PeerThreadsToolkit } from "./tools.ts";

const sshHostFromBaseUrl = (baseUrl: string): string | null => {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname.length === 0 ? null : hostname;
  } catch {
    return null;
  }
};

const handlers = {
  peers_list: () =>
    Effect.gen(function* () {
      const invocation = yield* requireThreadsCapability("list");
      const mayReachMachines = permitsThreadOperation(
        { kind: "mcp", capabilities: invocation.capabilities },
        { operation: "create", remote: true },
      );
      const registry = yield* PeerRegistry;
      const peers = yield* registry.list.pipe(
        Effect.mapError(
          () =>
            new PeerFederationError({
              operation: "list",
              reason: "registry_unavailable",
              detail: "The fleet node registry is unavailable.",
            }),
        ),
      );
      return {
        connections: peers
          .map((peer) => ({
            name: peer.name,
            label: peer.label,
            baseUrl: peer.baseUrl,
            sshHost: mayReachMachines ? sshHostFromBaseUrl(peer.baseUrl) : null,
            sshUser: mayReachMachines ? peer.sshUser : null,
            environmentId: peer.environmentId,
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    }),

  peer_threads_list: (input) =>
    threadToolOperations
      .threads_list({
        ...(input.peer === undefined ? {} : { node: input.peer }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.allProjects === undefined ? {} : { allProjects: input.allProjects }),
      })
      .pipe(
        Effect.map((result) => ({
          threads: result.threads.map(({ node, local: _local, ...thread }) => ({
            ...thread,
            peer: PeerName.make(node),
          })),
          totalAvailable: result.totalAvailable,
          peersQueried: result.nodesQueried.map((node) => PeerName.make(node)),
          failures: result.failures.map((failure) => ({
            peer: PeerName.make(failure.node),
            reason: failure.reason,
          })),
          order: result.order,
          nextCursor: result.nextCursor,
        })),
      ),

  peer_thread_read: (input) =>
    threadToolOperations
      .thread_read({
        threadId: input.threadId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.before === undefined ? {} : { before: input.before }),
      })
      .pipe(
        Effect.map(({ node, local: _local, ...result }) => ({
          ...result,
          peer: PeerName.make(node),
        })),
      ),

  peer_thread_send: (input) =>
    threadToolOperations
      .thread_send({
        threadId: input.threadId,
        message: input.message,
        ...(input.queue === undefined ? {} : { queue: input.queue }),
      })
      .pipe(
        Effect.map((result) => ({
          peer: result.local ? null : PeerName.make(result.node),
          threadId: result.threadId,
          delivery: result.delivery,
          pending: result.pending,
          deliveredAt: result.deliveredAt,
        })),
      ),

  peer_thread_create: (input) =>
    threadToolOperations
      .thread_create({
        node: input.peer,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.project === undefined ? {} : { project: input.project }),
        title: input.title,
        message: input.message,
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      })
      .pipe(
        Effect.map((result) => ({
          peer: PeerName.make(result.node),
          threadId: result.threadId,
          projectId: result.projectId,
          title: result.title,
        })),
      ),
} satisfies Parameters<typeof PeerThreadsToolkit.toLayer>[0];

export const PeerThreadsToolkitHandlersLive = PeerThreadsToolkit.toLayer(handlers);
