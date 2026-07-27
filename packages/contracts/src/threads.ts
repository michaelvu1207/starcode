/**
 * Threads - starting work on this machine.
 *
 * The local half of what `peers.ts` does across machines. `peer_thread_create`
 * starts a thread on another environment; nothing started one *here*, so an
 * agent that wanted a helper on its own connection had no way to ask for it
 * short of registering the machine as its own peer — a loopback HTTP hop and a
 * minted credential to reach an engine already running in the same process.
 *
 * The asymmetry was never argued for. `PeerThreadWriter`'s own module docstring
 * gives a reason `send` has a local form ("threads on one machine need to talk
 * to each other as much as threads across machines do") and a reason `dispatch`
 * deliberately does not ("interrupting a thread on the machine the operator is
 * sitting at is theirs to do"). For `create` it says nothing, because the case
 * simply never came up: the orchestration doctrine describes the master planner
 * as fanning work *out*, and local threads were assumed to be born from a click.
 *
 * Deliberately not gated. Creating a thread here costs a turn and money, which
 * is the argument for master-only that `peer_thread_create` rests on — but a
 * worker that cannot start its own helper is amputated in the same way a worker
 * that could not leave a mailbox message would be, and that is the comparison
 * `capabilityToolFilter` already makes for `peer_thread_send`. The runaway
 * concern that master-only was implicitly answering is handled where it
 * actually lives: a per-turn creation cap in the writer.
 *
 * @module Threads
 */
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProjectCategorySlug } from "./projectCategorySlug.ts";

export const ThreadToolOperation = Schema.Literals(["create"]);
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

export const ThreadCreateInput = Schema.Struct({
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
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type ThreadCreateResult = typeof ThreadCreateResult.Type;
