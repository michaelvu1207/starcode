import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  FleetNodeName,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationThreadShell,
  type ThreadMailboxOrigin,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FleetRegistry } from "../fleet/FleetRegistry.ts";
import { EMPTY_FLEET_ROSTER } from "../fleet/FleetRoster.ts";
import { FleetThreadIndex } from "../fleet/FleetThreadIndex.ts";
import { ThreadMailbox } from "../mailbox/ThreadMailbox.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";
import { ThreadService, layer as threadServiceLayer } from "./ThreadService.ts";

const localId = ThreadId.make("thread-local");
const remoteId = ThreadId.make("thread-remote");
const callerId = ThreadId.make("thread-caller");

const shell = (id: ThreadId, updatedAt: string): OrchestrationThreadShell =>
  ({
    id,
    projectId: ProjectId.make("project-1"),
    title: id === localId ? "Local task" : "Remote task",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sideOfThreadId: null,
    latestTurn: null,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    goalSummary: null,
  }) as OrchestrationThreadShell;

const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("alpha-environment"),
  label: "alpha",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: false },
};

const origin: ThreadMailboxOrigin = {
  environmentId: descriptor.environmentId,
  environmentLabel: descriptor.label,
  threadId: callerId,
  threadTitle: "Caller task",
};

const harness = (
  fleetLocation: Option.Option<{
    readonly environmentId: EnvironmentId;
    readonly node: FleetNodeName;
    readonly local: boolean;
  }> = Option.none(),
) => {
  const dispatched: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  const replacements: Array<{
    readonly entries: ReadonlyArray<Record<string, unknown>>;
    readonly node: EnvironmentId;
  }> = [];
  const environmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(descriptor.environmentId),
    getDescriptor: Effect.succeed(descriptor),
  });
  const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [],
        threads: [shell(localId, "2026-07-30T10:00:00.000Z")],
        updatedAt: "2026-07-30T12:00:00.000Z",
      }),
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === localId
          ? Option.some(shell(localId, "2026-07-30T10:00:00.000Z"))
          : Option.none(),
      ),
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(
        projectId === ProjectId.make("project-1")
          ? Option.some({
              id: projectId,
              title: "Project 1",
              workspaceRoot: "/workspace/project-1",
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("claude"),
                model: "opus",
              },
              scripts: [],
              createdAt: "2026-07-30T09:00:00.000Z",
              updatedAt: "2026-07-30T09:00:00.000Z",
            })
          : Option.none(),
      ),
  } as never);
  const projectCatalogLayer = Layer.succeed(ProjectCatalogRegistry, {
    list: Effect.succeed([]),
  } as never);
  const fleetRegistryLayer = Layer.succeed(FleetRegistry, {
    snapshot: Effect.succeed(EMPTY_FLEET_ROSTER),
    resolveByEnvironmentId: () => Effect.succeed(Option.none()),
  } as never);
  const mailboxLayer = Layer.succeed(ThreadMailbox, {
    enqueue: (input: Record<string, unknown>) => {
      queued.push(input);
      return Effect.succeed({ entry: {} as never, pending: queued.length });
    },
  } as never);
  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: Record<string, unknown>) => {
      dispatched.push(command);
      return Effect.succeed({ sequence: dispatched.length });
    },
  } as never);
  const fleetSnapshot = {
    revision: 1,
    entries: [
      {
        threadId: remoteId,
        node: EnvironmentId.make("beta-environment"),
        nodeName: FleetNodeName.make("beta"),
        project: null,
        title: "Remote task",
        status: "working" as const,
        lastActivityAt: "2026-07-30T12:00:00.000Z",
        createdAt: "2026-07-30T11:00:00.000Z",
        provider: "claude",
        model: "opus",
        branch: null,
      },
    ],
    failures: [
      {
        node: EnvironmentId.make("gamma-environment"),
        nodeName: FleetNodeName.make("gamma"),
        reason: "unreachable" as const,
      },
    ],
  };
  const fleetIndexLayer = Layer.succeed(FleetThreadIndex, {
    snapshot: Effect.succeed(fleetSnapshot),
    lookup: () => Effect.succeed(fleetLocation),
    replaceNodeEntries: (entries: ReadonlyArray<Record<string, unknown>>, node: EnvironmentId) => {
      replacements.push({ entries, node });
      return Effect.succeed(fleetSnapshot);
    },
  } as never);
  const layer = threadServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environmentLayer,
        projectionLayer,
        projectCatalogLayer,
        fleetRegistryLayer,
        mailboxLayer,
        engineLayer,
        fleetIndexLayer,
        NodeCrypto.layer,
        Layer.succeed(HttpClient.HttpClient, {} as never),
      ),
    ),
  );
  return { layer, dispatched, queued, replacements };
};

it.effect("merges local and remote threads while preserving per-node failures", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const service = yield* ThreadService;
    const result = yield* service.listThreads({});

    expect(result.threads.map((thread) => thread.threadId)).toEqual([remoteId, localId]);
    expect(result.threads.find((thread) => thread.threadId === localId)).toMatchObject({
      node: descriptor.environmentId,
      local: true,
    });
    expect(result.failures).toEqual([{ node: "gamma", reason: "Fleet node is unreachable." }]);
  }).pipe(Effect.provide(layer));
});

it.effect("delivers a local send directly through canonical orchestration", () => {
  const { layer, dispatched, queued } = harness();
  return Effect.gen(function* () {
    const service = yield* ThreadService;
    const result = yield* service.sendMessage({
      threadId: localId,
      message: "local delivery",
      origin,
    });

    expect(result).toMatchObject({ local: true, threadId: localId, delivery: "now" });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: localId,
      message: { role: "user", authoredBy: "agent" },
    });
    expect(queued).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("routes create, turn, and archive lifecycle commands through one dispatcher", () => {
  const { layer, dispatched } = harness();
  return Effect.gen(function* () {
    const service = yield* ThreadService;
    yield* service.dispatchCreate({
      type: "thread.create",
      commandId: CommandId.make("create-1"),
      threadId: ThreadId.make("thread-new"),
      projectId: ProjectId.make("project-1"),
      title: "New task",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-07-30T12:00:00.000Z",
    });
    yield* service.startTurn({
      type: "thread.turn.start",
      commandId: CommandId.make("turn-1"),
      threadId: ThreadId.make("thread-new"),
      message: {
        messageId: "message-1",
        role: "user",
        text: "start",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-07-30T12:00:01.000Z",
    } as never);
    yield* service.setArchived({
      type: "thread.archive",
      commandId: CommandId.make("archive-1"),
      threadId: ThreadId.make("thread-new"),
    });

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.archive",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("creates a local thread and starts its first turn inside ThreadService", () => {
  const { layer, dispatched } = harness();
  return Effect.gen(function* () {
    const service = yield* ThreadService;
    const result = yield* service.createThread({
      callerThreadId: callerId,
      projectId: ProjectId.make("project-1"),
      title: "Created locally",
      message: "Start the task",
    });

    expect(result).toMatchObject({
      local: true,
      projectId: ProjectId.make("project-1"),
      title: "Created locally",
    });
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("pushes local projection changes into the authoritative fleet index", () => {
  const { layer, replacements } = harness();
  return Effect.gen(function* () {
    const service = yield* ThreadService;
    yield* service.refreshLocalIndex;

    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.node).toBe(descriptor.environmentId);
    expect(replacements[0]?.entries).toEqual([
      expect.objectContaining({
        threadId: localId,
        node: descriptor.environmentId,
        title: "Local task",
      }),
    ]);
  }).pipe(Effect.provide(layer));
});
