import {
  PeerFederationError,
  resolveLocalProjectMembership,
  type PeerFederationOperation,
  type ThreadId,
  type ThreadMailboxOrigin,
} from "@starcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerThreadReader from "../../../peers/PeerThreadReader.ts";
import * as PeerThreadWriter from "../../../peers/PeerThreadWriter.ts";
import { PeerRegistry } from "../../../peers/PeerRegistry.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
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
              "Only the designated workbench master thread may create threads on other machines. Use peer_thread_send to reach a thread that already exists.",
          }),
    ),
  );

/**
 * The host an agent would SSH to, taken from the peer's own base URL so the two
 * can never drift. `URL` handles IPv6 brackets and ports for us; anything it
 * cannot parse yields null rather than a guess, because a wrong host in an
 * `ssh` command is worse than an absent one.
 */
const sshHostFromBaseUrl = (baseUrl: string): string | null => {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname.length === 0 ? null : hostname;
  } catch {
    return null;
  }
};

/**
 * Which project the calling thread sits under, for the default scope.
 *
 * Refuses rather than widening. If the caller is unfiled we cannot answer "who
 * else is on my project", and quietly returning every thread on every machine
 * would be the firehose this default exists to prevent — an agent would read it
 * as its project being far busier than it is. An unreadable catalog is treated
 * the same way, because "I could not tell" and "you have no project" both mean
 * the scope is unknown.
 */
const callerProject = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* ProjectCatalogRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const [categories, shell] = yield* Effect.all(
      [
        registry.list.pipe(Effect.orElseSucceed(() => [])),
        projectionSnapshotQuery.getShellSnapshot().pipe(Effect.orElseSucceed(() => undefined)),
      ],
      { concurrency: 2 },
    );

    const membership =
      shell === undefined
        ? undefined
        : resolveLocalProjectMembership({
            categories,
            threads: shell.threads.map((thread) => ({
              id: thread.id,
              projectId: thread.projectId,
            })),
          });

    const slug =
      membership === undefined
        ? undefined
        : Array.from(membership).find(([, threadIds]) => threadIds.includes(threadId))?.[0];

    if (slug === undefined) {
      return yield* new PeerFederationError({
        operation: "list",
        reason: "caller_project_unknown",
        detail:
          "This thread is not filed under a project, so there is no default scope. Pass project to name one, or allProjects to list every project.",
      });
    }
    return slug;
  });

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
  peers_list: () =>
    Effect.gen(function* () {
      const invocation = yield* requirePeerCapability("list");
      /**
       * The SSH login is withheld from ordinary sessions.
       *
       * Everything else this toolkit exposes is bounded by the toolkit: a worker
       * can read a peer thread and send it a message, and cannot do anything
       * else to that machine. `ssh user@host` is not bounded by anything — it is
       * a shell, on a box, as a user who can run the agent stack. Handing that to
       * every session while carefully gating `peer_thread_create` behind
       * `peers-operate` would make the gate decorative, since the cheaper way
       * around it was two fields down in the same response.
       *
       * It is a withholding rather than a refusal: the connection still lists,
       * with its name and URL, because those are what the other tools take. Only
       * the login is absent, and only for sessions that were not trusted with
       * operating on other machines in the first place.
       */
      const mayReachMachines = invocation.capabilities.has("peers-operate");
      const registry = yield* PeerRegistry;
      const peers = yield* registry.list.pipe(
        Effect.catchCause(
          (cause) =>
            new PeerFederationError({
              operation: "list",
              reason: "registry_unavailable",
              detail: Cause.pretty(cause),
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
            credentialClass: peer.credentialClass,
            environmentId: peer.environmentId,
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    }),

  peer_threads_list: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requirePeerCapability("list");
      if (input.project !== undefined && input.allProjects === true) {
        return yield* new PeerFederationError({
          operation: "list",
          reason: "project_scope_ambiguous",
          detail:
            "Pass project to scope to one project, or allProjects to see them all — not both.",
        });
      }

      /**
       * Resolved here rather than in the reader because this is the only layer
       * that knows who is calling. `allProjects` skips the lookup entirely, so
       * asking for the fleet-wide view never fails on a caller that happens to
       * be unfiled.
       */
      const project =
        input.allProjects === true
          ? undefined
          : (input.project ?? (yield* callerProject(invocation.threadId)));

      const reader = yield* PeerThreadReader.PeerThreadReader;
      return yield* reader.listThreads({
        ...(input.peer === undefined ? {} : { peer: input.peer }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(project === undefined ? {} : { project }),
      });
    }),
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
        ...(input.queue === undefined ? {} : { queue: input.queue }),
        origin,
      });
    }),
  peer_thread_create: (input) =>
    Effect.gen(function* () {
      yield* requireOperateCapability("create");
      // Exactly one way of saying where, refused rather than resolved by
      // precedence: an agent that passed both is an agent that believes
      // something about this call, and quietly honouring one of them would let
      // that belief stay wrong.
      if ((input.project === undefined) === (input.projectId === undefined)) {
        return yield* new PeerFederationError({
          operation: "create",
          reason: "project_not_found",
          peer: input.peer,
          detail:
            input.project === undefined
              ? "Say where the thread goes: pass project (a slug, the same on every machine) or projectId (that peer's own folder id)."
              : "Pass project or projectId, not both — they can name different folders.",
        });
      }
      const writer = yield* PeerThreadWriter.PeerThreadWriter;
      return yield* writer.createThread({
        peer: input.peer,
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
} satisfies Parameters<typeof PeerThreadsToolkit.toLayer>[0];

export const PeerThreadsToolkitHandlersLive = PeerThreadsToolkit.toLayer(handlers);
