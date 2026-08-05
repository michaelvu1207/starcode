/** Canonical fleet-wide thread tools. @module ThreadTools */
import {
  PeerFederationError,
  ThreadCreateInput,
  ThreadReadInput,
  ThreadReadResult,
  ThreadSendInput,
  ThreadSendResult,
  ThreadServiceCreateResult,
  ThreadsListInput,
  ThreadsListResult,
} from "@starcode/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadService } from "../../../threads/ThreadService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadService,
  ServerEnvironment.ServerEnvironment,
  ProjectionSnapshotQuery,
  ProjectCatalogRegistry,
];

const readTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true) as T;

const writeTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true) as T;

export const ThreadsListTool = readTool(
  Tool.make("threads_list", {
    description:
      "List threads on this machine and every reachable fleet node in one result. The optional node only filters the view. A failed node appears in failures and does not hide surviving threads.",
    parameters: ThreadsListInput,
    success: ThreadsListResult,
    failure: PeerFederationError,
    dependencies,
  }).annotate(Tool.Title, "List fleet threads"),
);

export const ThreadReadTool = readTool(
  Tool.make("thread_read", {
    description:
      "Read a thread transcript by id. The server locates the thread; do not pass a machine.",
    parameters: ThreadReadInput,
    success: ThreadReadResult,
    failure: PeerFederationError,
    dependencies,
  }).annotate(Tool.Title, "Read a thread"),
);

export const ThreadSendTool = writeTool(
  Tool.make("thread_send", {
    description:
      "Send a message to a thread by id. The server locates it locally or across the fleet. Use queue=true only when the recipient need not wake now.",
    parameters: ThreadSendInput,
    success: ThreadSendResult,
    failure: PeerFederationError,
    dependencies,
  }).annotate(Tool.Title, "Send a message to a thread"),
);

export const ThreadCreateTool = writeTool(
  Tool.make("thread_create", {
    description:
      "Create a thread and start its first turn. Omit node for this machine or choose a fleet node as preferred placement. Pass exactly one of project or projectId.",
    parameters: ThreadCreateInput,
    success: ThreadServiceCreateResult,
    failure: PeerFederationError,
    dependencies,
  }).annotate(Tool.Title, "Create a thread"),
);

export const ThreadsToolkit = Toolkit.make(
  ThreadsListTool,
  ThreadReadTool,
  ThreadSendTool,
  ThreadCreateTool,
);
