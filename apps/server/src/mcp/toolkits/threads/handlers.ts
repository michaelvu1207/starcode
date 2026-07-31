/** Handlers for the canonical fleet-wide thread toolkit. @module ThreadHandlers */
import {
  PeerFederationError,
  resolveLocalProjectMembership,
  type PeerFederationOperation,
  type ThreadId,
  type ThreadMailboxOrigin,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import { permitsThreadOperation } from "../../../threads/ThreadCapability.ts";
import { ThreadService } from "../../../threads/ThreadService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkit } from "./tools.ts";

export const requireThreadsCapability = (operation: PeerFederationOperation) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (
      !permitsThreadOperation({ kind: "mcp", capabilities: invocation.capabilities }, { operation })
    ) {
      return yield* new PeerFederationError({
        operation,
        reason: "capability_unavailable",
        detail: "This MCP credential does not grant the threads capability.",
      });
    }
    return invocation;
  });

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
        detail: "This thread is not filed under a project. Pass project or allProjects=true.",
      });
    }
    return slug;
  });

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

export const threadToolOperations = {
  threads_list: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireThreadsCapability("list");
      if (input.project !== undefined && input.allProjects === true) {
        return yield* new PeerFederationError({
          operation: "list",
          reason: "project_scope_ambiguous",
          detail: "Pass project or allProjects=true, not both.",
        });
      }
      const project =
        input.allProjects === true
          ? undefined
          : (input.project ?? (yield* callerProject(invocation.threadId)));
      const service = yield* ThreadService;
      return yield* service.listThreads({
        ...(input.node === undefined ? {} : { node: input.node }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(project === undefined ? {} : { project }),
      });
    }),
  thread_read: (input) =>
    Effect.gen(function* () {
      yield* requireThreadsCapability("read");
      const service = yield* ThreadService;
      return yield* service.readThread({
        threadId: input.threadId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.before === undefined ? {} : { before: input.before }),
      });
    }),
  thread_send: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireThreadsCapability("send");
      const origin = yield* resolveOrigin(invocation);
      const service = yield* ThreadService;
      return yield* service.sendMessage({
        threadId: input.threadId,
        message: input.message,
        origin,
        ...(input.queue === undefined ? {} : { queue: input.queue }),
      });
    }),
  thread_create: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireThreadsCapability("create");
      if (
        !permitsThreadOperation(
          { kind: "mcp", capabilities: invocation.capabilities },
          { operation: "create", remote: input.node !== undefined },
        )
      ) {
        return yield* new PeerFederationError({
          operation: "create",
          reason: "capability_unavailable",
          detail: "Only an orchestrator may place a new thread on another fleet node.",
        });
      }
      if ((input.project === undefined) === (input.projectId === undefined)) {
        return yield* new PeerFederationError({
          operation: "create",
          reason: "project_not_found",
          detail:
            input.project === undefined
              ? "Say where the thread goes: pass project (a slug, as project_list reports it) or projectId (this machine's own folder id)."
              : "Pass project or projectId, not both — they can name different folders.",
        });
      }
      const service = yield* ThreadService;
      return yield* service.createThread({
        callerThreadId: invocation.threadId,
        ...(input.node === undefined ? {} : { node: input.node }),
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

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(threadToolOperations);
