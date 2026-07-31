import {
  PeerFederationError,
  PeerThreadCreateInput,
  PeerThreadCreateResult,
  PeerThreadReadInput,
  PeerThreadReadResult,
  PeerThreadSendInput,
  PeerThreadSendResult,
  PeerThreadsListInput,
  PeerThreadsListResult,
  PeersListInput,
  PeersListResult,
} from "@starcode/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { PeerRegistry } from "../../../peers/PeerRegistry.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadService } from "../../../threads/ThreadService.ts";

/**
 * `peer_threads_list` defaults to the caller's own project, and resolving that
 * means reading this machine's catalog and its thread projection — so the
 * listing tool depends on both even though neither is a parameter.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadService,
  ProjectCatalogRegistry,
  ProjectionSnapshotQuery,
];

/** `peers_list` reads the registry and nothing else. */
const connectionDependencies = [McpInvocationContext.McpInvocationContext, PeerRegistry];
// `send` stamps provenance from server state rather than from the tool call,
// so the environment descriptor and the thread projection are dependencies of
// the toolkit even though no tool takes them as parameters.
const writeDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadService,
  ServerEnvironment.ServerEnvironment,
  ProjectionSnapshotQuery,
];

/** Federation only ever reads, so every tool here is read-only and open-world. */
const peerReadTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true) as T;

export const PeerThreadsListTool = peerReadTool(
  Tool.make("peer_threads_list", {
    description:
      "Deprecated compatibility alias for threads_list. Lists agent threads and preserves the old peer-shaped response for one release.",
    parameters: PeerThreadsListInput,
    success: PeerThreadsListResult,
    failure: PeerFederationError,
    dependencies,
  }).annotate(Tool.Title, "List peer threads"),
);

export const PeerThreadReadTool = peerReadTool(
  Tool.make("peer_thread_read", {
    description:
      "Deprecated compatibility alias for thread_read. The peer argument is accepted for old callers; routing is resolved from the thread id.",
    parameters: PeerThreadReadInput,
    success: PeerThreadReadResult,
    failure: PeerFederationError,
    dependencies,
  }).annotate(Tool.Title, "Read a peer thread"),
);

/**
 * Every write here spends the recipient's money and takes its attention, so all
 * three are annotated the same way. `send` was once the exception — it could not
 * cause a turn, so it cost the recipient nothing until one happened anyway — and
 * that stopped being true when it began delivering immediately. A client that
 * decides whether to confirm a tool call from these annotations should be told
 * what the call actually does now, not what it used to.
 */
const peerWriteTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true) as T;

export const PeerThreadSendTool = peerWriteTool(
  Tool.make("peer_thread_send", {
    description:
      "Deprecated compatibility alias for thread_send. The peer argument is accepted for old callers; routing is resolved from the thread id.",
    parameters: PeerThreadSendInput,
    success: PeerThreadSendResult,
    failure: PeerFederationError,
    dependencies: writeDependencies,
  }).annotate(Tool.Title, "Send a message to a thread"),
);

export const PeerThreadCreateTool = peerWriteTool(
  Tool.make("peer_thread_create", {
    description:
      "Deprecated compatibility alias for thread_create. Creates on the peer named by the old input shape.",
    parameters: PeerThreadCreateInput,
    success: PeerThreadCreateResult,
    failure: PeerFederationError,
    dependencies: writeDependencies,
  }).annotate(Tool.Title, "Create a thread on a peer"),
);

/**
 * The one tool here that answers a question about this machine rather than a
 * peer, and it exists because every other tool takes a peer name it had no way
 * to discover. Registry-only: it never touches the network, so an unreachable
 * machine still lists, which is precisely when an agent wants the SSH login.
 */
export const PeersListTool = peerReadTool(
  Tool.make("peers_list", {
    description:
      "Deprecated compatibility alias for listing fleet machines. Returns each connection's legacy peer name, label, and base URL. Orchestrator threads additionally get the SSH login: combine sshUser with sshHost to reach a machine directly (ssh user@host) when you need to inspect the box rather than talk to a thread on it. Both are null if this session is not one, which is a statement about this session rather than about the node. Reads the local fleet roster only, so a machine that is down still appears.",
    parameters: PeersListInput,
    success: PeersListResult,
    failure: PeerFederationError,
    dependencies: connectionDependencies,
  }).annotate(Tool.Title, "List connections"),
);

export const PeerThreadsToolkit = Toolkit.make(
  PeersListTool,
  PeerThreadsListTool,
  PeerThreadReadTool,
  PeerThreadSendTool,
  PeerThreadCreateTool,
);
