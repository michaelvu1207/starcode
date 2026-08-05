import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MESSAGE_SIMPLIFICATION_INSTRUCTIONS_MAX_LENGTH = 4_000;
export const DEFAULT_MESSAGE_SIMPLIFICATION_INSTRUCTIONS = [
  "Preserve the outcome, important decisions, warnings, uncertainty, commands, paths, identifiers, and next steps.",
  "Use concise Markdown: a short paragraph or a small bullet list, whichever is clearer.",
  "Make the result materially shorter than the source and do not announce that it is a summary.",
].join("\n");

export const MessageSimplificationInstructions = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MESSAGE_SIMPLIFICATION_INSTRUCTIONS_MAX_LENGTH),
);
export type MessageSimplificationInstructions = typeof MessageSimplificationInstructions.Type;

export const MessageSimplificationInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  instructions: Schema.optionalKey(MessageSimplificationInstructions),
});
export type MessageSimplificationInput = typeof MessageSimplificationInput.Type;

export const MessageSimplificationResult = Schema.Struct({
  summary: TrimmedNonEmptyString,
});
export type MessageSimplificationResult = typeof MessageSimplificationResult.Type;

export const MessageSimplificationFailureReason = Schema.Literals([
  "thread_not_found",
  "message_not_found",
  "message_not_simplifiable",
  "provider_unavailable",
  "generation_failed",
]);
export type MessageSimplificationFailureReason = typeof MessageSimplificationFailureReason.Type;

export class MessageSimplificationError extends Schema.TaggedErrorClass<MessageSimplificationError>()(
  "MessageSimplificationError",
  {
    reason: MessageSimplificationFailureReason,
    message: TrimmedNonEmptyString,
  },
) {}
