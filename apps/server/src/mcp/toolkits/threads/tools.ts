/**
 * The local counterpart to the peer-thread write tools.
 *
 * Kept a separate tool from `peer_thread_create` rather than a `peer?` on it,
 * even though `peer_thread_send` establishes the omit-peer-for-local shape. The
 * reason is the capability filter: it hides tools by *name*, and these two have
 * different audiences — `peer_thread_create` is master-only and stays hidden
 * from workers, while this one is open to every session. One name cannot be
 * both, and ungating the shared name would show every worker a tool whose peer
 * form it can never call, which is exactly the wasted-turn cost that filter
 * exists to prevent.
 *
 * @module ThreadTools
 */
import { ThreadCreateInput, ThreadCreateResult, ThreadToolError } from "@starcode/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LocalThreadWriter } from "../../../threads/LocalThreadWriter.ts";

export const ThreadCreateTool = Tool.make("thread_create", {
  description:
    "Create a new agent thread on THIS machine and start it working on a first message. Use this to delegate work to a fresh thread on your own connection — for a thread on another machine, use peer_thread_create instead. Say where it goes with project (a slug from project_list) or projectId; provider instance, model and modes default to that project's own settings. The new thread begins a turn immediately, so give it a message it can act on without you. Capped at 3 per turn.",
  parameters: ThreadCreateInput,
  success: ThreadCreateResult,
  failure: ThreadToolError,
  dependencies: [McpInvocationContext.McpInvocationContext, LocalThreadWriter],
})
  .annotate(Tool.Title, "Create a thread on this machine")
  .annotate(Tool.Readonly, false)
  // Destructive in the same sense `peer_thread_create` is: it spends money and
  // takes attention. Nothing it does can be undone by calling it again, which
  // is also why it is not idempotent.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  // Closed-world, unlike every peer tool: this one never leaves the machine.
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(ThreadCreateTool);
