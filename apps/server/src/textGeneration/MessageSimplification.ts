import {
  MessageSimplificationError,
  type MessageSimplificationInput,
  type MessageSimplificationResult,
  ProviderInstanceId,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";

export const MESSAGE_SIMPLIFICATION_MODEL = "openai-codex/gpt-5.6-sol";
export const MESSAGE_SIMPLIFICATION_REASONING_EFFORT = "low";

const failure = (
  reason: MessageSimplificationError["reason"],
  message: string,
): MessageSimplificationError => new MessageSimplificationError({ reason, message });

export const simplifyAssistantMessage = Effect.fn("MessageSimplification.simplifyAssistantMessage")(
  function* (
    input: MessageSimplificationInput,
  ): Effect.fn.Return<
    MessageSimplificationResult,
    MessageSimplificationError,
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
    | ProviderInstanceRegistry.ProviderInstanceRegistry
  > {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

    const threadOption = yield* snapshots
      .getThreadDetailById(input.threadId)
      .pipe(
        Effect.mapError(() =>
          failure("generation_failed", "The thread could not be loaded for simplification."),
        ),
      );
    const thread = Option.getOrUndefined(threadOption);
    if (!thread) {
      return yield* failure("thread_not_found", "The thread no longer exists.");
    }

    const message = thread.messages.find((candidate) => candidate.id === input.messageId);
    if (!message) {
      return yield* failure("message_not_found", "The assistant message no longer exists.");
    }
    if (message.role !== "assistant" || message.streaming || message.text.trim().length === 0) {
      return yield* failure(
        "message_not_simplifiable",
        "Only completed assistant messages with text can be simplified.",
      );
    }

    const projectOption = yield* snapshots
      .getProjectShellById(thread.projectId)
      .pipe(
        Effect.mapError(() =>
          failure("generation_failed", "The message workspace could not be loaded."),
        ),
      );
    const project = Option.getOrUndefined(projectOption);
    if (!project) {
      return yield* failure("generation_failed", "The message workspace no longer exists.");
    }

    const instances = yield* instanceRegistry.listInstances;
    const piInstances = instances.filter(
      (instance) => instance.enabled && instance.driverKind === "pi",
    );
    const selectedInstance =
      piInstances.find((instance) => instance.instanceId === thread.modelSelection.instanceId) ??
      piInstances.find((instance) => instance.instanceId === ProviderInstanceId.make("pi")) ??
      piInstances[0];
    if (!selectedInstance) {
      return yield* failure("provider_unavailable", "Simplify requires an enabled Pi provider.");
    }

    const generated = yield* selectedInstance.textGeneration
      .generateMessageSummary({
        cwd: thread.worktreePath ?? project.workspaceRoot,
        message: message.text,
        instructions: input.instructions,
        modelSelection: {
          instanceId: selectedInstance.instanceId,
          model: MESSAGE_SIMPLIFICATION_MODEL,
          options: [
            {
              id: "effort",
              value: MESSAGE_SIMPLIFICATION_REASONING_EFFORT,
            },
          ],
        },
      })
      .pipe(
        Effect.mapError(() =>
          failure("generation_failed", "The assistant response could not be simplified."),
        ),
      );

    return { summary: generated.summary };
  },
);
