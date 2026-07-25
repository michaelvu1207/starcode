import {
  PeerFederationError,
  PeerThreadCreateInput,
  PeerThreadCreateResult,
  PeerThreadDispatchInput,
  PeerThreadDispatchResult,
  PeerThreadReadInput,
  PeerThreadReadResult,
  PeerThreadSendInput,
  PeerThreadSendResult,
  PeerThreadsListInput,
  PeerThreadsListResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerThreadReader from "../../../peers/PeerThreadReader.ts";
import * as PeerThreadWriter from "../../../peers/PeerThreadWriter.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, PeerThreadReader.PeerThreadReader];
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
 * Writes are annotated honestly rather than uniformly. `send` is idempotent-ish
 * chatter that costs the recipient nothing until it turns anyway; `create` and
 * `dispatch` spend the recipient's money and take its attention, and a client
 * that decides whether to confirm a tool call from these annotations should be
 * told the difference.
 */
const peerWriteTool = <T extends Tool.Any>(tool: T, destructive: boolean): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, destructive)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true) as T;

export const PeerThreadSendTool = peerWriteTool(
  Tool.make("peer_thread_send", {
    description:
      "Leave a message in another thread's mailbox. The message is delivered the next time that thread takes a turn — it does NOT wake the thread, interrupt it, or cost it a turn, so a thread that is idle will not see it until something else starts it working. Use this for coordination between agents. Omit peer to message a thread on this machine. A thread cannot message itself.",
    parameters: PeerThreadSendInput,
    success: PeerThreadSendResult,
    failure: PeerFederationError,
    dependencies: writeDependencies,
  }).annotate(Tool.Title, "Send a message to a thread"),
  false,
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
  true,
);

export const PeerThreadDispatchTool = peerWriteTool(
  Tool.make("peer_thread_dispatch", {
    description:
      "Send a message to a thread on a peer machine and start a turn on it immediately, interrupting whatever it is doing. This costs that thread a turn. Reserve it for starting and stopping work; for everything else use peer_thread_send, which waits.",
    parameters: PeerThreadDispatchInput,
    success: PeerThreadDispatchResult,
    failure: PeerFederationError,
    dependencies: writeDependencies,
  }).annotate(Tool.Title, "Interrupt a thread on a peer"),
  true,
);

export const PeerThreadsToolkit = Toolkit.make(
  PeerThreadsListTool,
  PeerThreadReadTool,
  PeerThreadSendTool,
  PeerThreadCreateTool,
  PeerThreadDispatchTool,
);
