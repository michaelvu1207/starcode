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
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerThreadReader from "../../../peers/PeerThreadReader.ts";
import * as PeerThreadWriter from "../../../peers/PeerThreadWriter.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { PeerRegistry } from "../../../peers/PeerRegistry.ts";
import { ProjectCatalogRegistry } from "../../../projectCatalog/ProjectCatalogRegistry.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * `peer_threads_list` defaults to the caller's own project, and resolving that
 * means reading this machine's catalog and its thread projection — so the
 * listing tool depends on both even though neither is a parameter.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PeerThreadReader.PeerThreadReader,
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
  PeerThreadWriter.PeerThreadWriter,
  PeerThreadReader.PeerThreadReader,
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
      "List agent threads running on other machines registered as peers of this environment. Returns thread id, title, provider, status, and last activity, most recently active first. Pass peer to scope to one machine; omit it to see every peer. To walk every thread rather than just the active head, pass order=created and follow nextCursor. Use this to find a thread, then read it with peer_thread_read.",
    parameters: PeerThreadsListInput,
    success: PeerThreadsListResult,
    failure: PeerFederationError,
    dependencies,
  }).annotate(Tool.Title, "List peer threads"),
);

export const PeerThreadReadTool = peerReadTool(
  Tool.make("peer_thread_read", {
    description:
      "Read a thread's transcript from a peer machine. Returns the newest 30 entries by default with roles, message text, and the tool names used in each turn; tool payloads are never included. Page backwards by passing the previous response's nextBefore as before, and stop when hasMore is false.",
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
      "Send a message to another agent thread. It arrives the way a message from your operator would: a thread sitting idle starts working on it right away, and a thread that is already working receives it as part of what it is doing. This costs that thread a turn, so send it something worth being interrupted for. Omit peer to message a thread on this machine; a thread cannot message itself. Pass queue=true instead to leave the message waiting for whenever that thread next works — free, but an idle thread may not read it for a long time.",
    parameters: PeerThreadSendInput,
    success: PeerThreadSendResult,
    failure: PeerFederationError,
    dependencies: writeDependencies,
  }).annotate(Tool.Title, "Send a message to a thread"),
);

export const PeerThreadCreateTool = peerWriteTool(
  Tool.make("peer_thread_create", {
    description:
      "Create a new agent thread on a peer machine and start it working on a first message. Pick projectId from the peer's projects; provider instance and model default to that project's own defaults. The new thread begins a turn immediately.",
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
      "List the machines this environment is paired with. Returns each connection's name — the name every other peer_* tool takes — plus its label, base URL and credential class. Orchestrator threads additionally get the SSH login: combine sshUser with sshHost to reach a machine directly (ssh user@host) when you need to inspect the box rather than talk to a thread on it. Both are null if this session is not one, which is a statement about this session rather than about the peer. Reads the local registry only, so a machine that is down still appears.",
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
