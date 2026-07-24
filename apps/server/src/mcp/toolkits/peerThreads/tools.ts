import {
  PeerFederationError,
  PeerThreadReadInput,
  PeerThreadReadResult,
  PeerThreadsListInput,
  PeerThreadsListResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerThreadReader from "../../../peers/PeerThreadReader.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, PeerThreadReader.PeerThreadReader];

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
      "List agent threads running on other machines registered as peers of this environment. Returns thread id, title, provider, status, and last activity, most recently active first. Pass peer to scope to one machine; omit it to see every peer. Use this to find a thread, then read it with peer_thread_read.",
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

export const PeerThreadsToolkit = Toolkit.make(PeerThreadsListTool, PeerThreadReadTool);
