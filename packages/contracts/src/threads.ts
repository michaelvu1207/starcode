/**
 * Threads - starting work on this machine.
 *
 * The local half of what `peers.ts` does across machines. `peer_thread_create`
 * starts a thread on another environment; nothing started one *here*, so an
 * agent that wanted a helper on its own connection had no way to ask for it
 * short of registering the machine as its own peer — a loopback HTTP hop and a
 * minted credential to reach an engine already running in the same process.
 *
 * `ThreadService` now applies the same canonical lifecycle path locally and
 * across the fleet; only the transport changes.
 *
 * Deliberately not gated. Creating a thread here costs a turn and money, which
 * is the argument for master-only that `peer_thread_create` rests on — but a
 * worker that cannot start its own helper is amputated in the same way a worker
 * that could not leave a mailbox message would be, and that is the comparison
 * `capabilityToolFilter` already makes for `peer_thread_send`. The runaway
 * concern that master-only was implicitly answering is handled where it
 * actually lives: a per-turn creation cap in the canonical service.
 *
 * @module Threads
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  OrchestrationThreadPlanSummary,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import { MAILBOX_MESSAGE_MAX_CHARS } from "./mailbox.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProjectCategorySlug } from "./projectCategorySlug.ts";

export const THREAD_READ_MAX_ENTRIES = 100;
export const THREAD_READ_DEFAULT_ENTRIES = 30;
export const THREADS_LIST_MAX = 200;
export const THREADS_LIST_DEFAULT = 50;

/**
 * A stable fleet node name. During the peers-to-fleet compatibility release it
 * is either a registered peer name or this node's environment id.
 */
export const ThreadNode = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ThreadNode = typeof ThreadNode.Type;

export const ThreadStatus = Schema.Literals([
  "approval",
  "input",
  "working",
  "failed",
  "archived",
  "idle",
]);
export type ThreadStatus = typeof ThreadStatus.Type;

export const ThreadCursor = Schema.Struct({
  createdAt: IsoDateTime,
  threadId: ThreadId,
});
export type ThreadCursor = typeof ThreadCursor.Type;

export const ThreadsOrder = Schema.Literals(["activity", "created"]);
export type ThreadsOrder = typeof ThreadsOrder.Type;

export const ThreadTranscriptEntry = Schema.Struct({
  index: NonNegativeInt,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  truncated: Schema.Boolean,
  toolCalls: Schema.Array(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type ThreadTranscriptEntry = typeof ThreadTranscriptEntry.Type;

export const ThreadSummary = Schema.Struct({
  node: ThreadNode,
  local: Schema.Boolean,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  provider: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  status: ThreadStatus,
  lastActivityAt: IsoDateTime,
  createdAt: IsoDateTime,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  planSummary: Schema.optionalKey(Schema.NullOr(OrchestrationThreadPlanSummary)),
  project: Schema.optionalKey(Schema.NullOr(ProjectCategorySlug)),
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const ThreadQueryFailure = Schema.Struct({
  node: ThreadNode,
  reason: TrimmedNonEmptyString,
});
export type ThreadQueryFailure = typeof ThreadQueryFailure.Type;

/**
 * The canonical fleet-wide list. `node` only narrows the view; it is never
 * needed by read or send, whose routing is owned by ThreadService.
 */
export const ThreadsListInput = Schema.Struct({
  node: Schema.optional(
    ThreadNode.annotate({
      description:
        "Restrict the result to one fleet node. Omit to include this machine and every reachable node.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(THREADS_LIST_MAX),
    ),
  ),
  order: Schema.optional(ThreadsOrder),
  cursor: Schema.optional(ThreadCursor),
  project: Schema.optional(ProjectCategorySlug),
  allProjects: Schema.optional(Schema.Boolean),
});
export type ThreadsListInput = typeof ThreadsListInput.Type;

export const ThreadsListResult = Schema.Struct({
  threads: Schema.Array(ThreadSummary),
  totalAvailable: NonNegativeInt,
  nodesQueried: Schema.Array(ThreadNode),
  failures: Schema.Array(ThreadQueryFailure),
  order: ThreadsOrder,
  nextCursor: Schema.NullOr(ThreadCursor),
});
export type ThreadsListResult = typeof ThreadsListResult.Type;

export const ThreadReadInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "Thread to read. ThreadService locates its node; callers never pass a machine.",
  }),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(THREAD_READ_MAX_ENTRIES),
    ).annotate({
      description: `Transcript entries to return. Defaults to the newest ${THREAD_READ_DEFAULT_ENTRIES}.`,
    }),
  ),
  before: Schema.optional(NonNegativeInt),
});
export type ThreadReadInput = typeof ThreadReadInput.Type;

export const ThreadReadResult = Schema.Struct({
  node: ThreadNode,
  local: Schema.Boolean,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  status: ThreadStatus,
  provider: Schema.NullOr(TrimmedNonEmptyString),
  totalEntries: NonNegativeInt,
  entries: Schema.Array(ThreadTranscriptEntry),
  hasMore: Schema.Boolean,
  nextBefore: Schema.NullOr(NonNegativeInt),
});
export type ThreadReadResult = typeof ThreadReadResult.Type;

export const ThreadSendInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "Thread to message. ThreadService locates its node; callers never pass a machine.",
  }),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(MAILBOX_MESSAGE_MAX_CHARS)).annotate({
    description: "Message to deliver.",
  }),
  queue: Schema.optional(Schema.Boolean),
});
export type ThreadSendInput = typeof ThreadSendInput.Type;

export const ThreadSendResult = Schema.Struct({
  node: ThreadNode,
  local: Schema.Boolean,
  threadId: ThreadId,
  delivery: Schema.Literals(["now", "queued"]),
  pending: NonNegativeInt,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type ThreadSendResult = typeof ThreadSendResult.Type;

/**
 * `deliver` is not a tool of its own — no MCP tool is named for it. It exists
 * because `peer_thread_send` now hands its message to a thread on this machine
 * through the same local writer, and a failure there has to say which operation
 * it was. Reporting a delivery failure as a failed `create` would send a reader
 * looking for a thread that was never being created.
 */
export const ThreadToolOperation = Schema.Literals(["create", "deliver"]);
export type ThreadToolOperation = typeof ThreadToolOperation.Type;

export const ThreadToolErrorReason = Schema.Literals([
  "capability_unavailable",
  /** No such project, or one that binds no folder / too many to choose from. */
  "project_not_found",
  /** Nothing at any layer supplied a complete provider + model pair. */
  "model_unavailable",
  /** The per-turn creation cap. Named separately so a caller can tell "you
      asked for too many" from "what you asked for is wrong". */
  "rate_limited",
  "dispatch_failed",
]);
export type ThreadToolErrorReason = typeof ThreadToolErrorReason.Type;

export class ThreadToolError extends Schema.TaggedErrorClass<ThreadToolError>()("ThreadToolError", {
  operation: ThreadToolOperation,
  reason: ThreadToolErrorReason,
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `Thread ${this.operation} failed: ${this.reason}.${
      this.detail === undefined ? "" : ` ${this.detail}`
    }`;
  }
}

export class ThreadLifecycleDispatchError extends Schema.TaggedErrorClass<ThreadLifecycleDispatchError>()(
  "ThreadLifecycleDispatchError",
  {
    operation: Schema.Literals(["create", "turn", "archive"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread ${this.operation} dispatch failed.`;
  }
}

export const ThreadCreateInput = Schema.Struct({
  node: Schema.optional(
    ThreadNode.annotate({
      description: "Preferred fleet node for the new thread. Omit to create it on this machine.",
    }),
  ),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Folder on this machine to create the thread in, by id. Omit when you pass project instead.",
    }),
  ),
  /**
   * The same slug-over-id preference `peer_thread_create` has, kept here even
   * though both sides are this machine: the slug is what the operator named the
   * project, it does the filing for free, and a caller that learned the name
   * from `project_list` should not have to learn an id as well.
   */
  project: Schema.optional(
    ProjectCategorySlug.annotate({
      description:
        "Project slug to create the thread under. Resolves to whichever folder this machine binds to that project, and the new thread starts with that project's configured provider, model and modes. If several folders are bound and none is preferred, the call is refused rather than guessed — pass projectId then. Use project_list to see them.",
    }),
  ),
  title: TrimmedNonEmptyString.annotate({ description: "Short name for the new thread." }),
  message: TrimmedNonEmptyString.annotate({
    description: "First message. The new thread starts a turn on it immediately.",
  }),
  instanceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Provider instance, e.g. claude or codex. Defaults to the project's configured provider.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id for the new thread. Defaults to the project's configured model.",
    }),
  ),
  providerOptions: Schema.optional(
    ProviderOptionSelections.annotate({
      description:
        "Provider-specific reasoning and context selections. Omit to inherit the selected project or caller options; pass an empty array to clear inherited options.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({
      description:
        "How much the new thread may do without asking. Defaults to the project's setting, or full-access.",
    }),
  ),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description: "plan keeps the new thread read-only; default lets it edit.",
    }),
  ),
});
export type ThreadCreateInput = typeof ThreadCreateInput.Type;

export const ThreadCreateResult = Schema.Struct({
  node: Schema.optionalKey(ThreadNode),
  local: Schema.optionalKey(Schema.Boolean),
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type ThreadCreateResult = typeof ThreadCreateResult.Type;

/**
 * Transport-neutral create result. The old local result exposed the resolved
 * model while the peer result did not; the unified surface keeps only fields
 * both placements can promise.
 */
export const ThreadServiceCreateResult = Schema.Struct({
  node: ThreadNode,
  local: Schema.Boolean,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
});
export type ThreadServiceCreateResult = typeof ThreadServiceCreateResult.Type;
