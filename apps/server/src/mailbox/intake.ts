/**
 * The two refusals every mailbox send must pass, wherever it came from.
 *
 * These live apart from the store because they need the projection and this
 * environment's own identity, and apart from the HTTP route because a local
 * send never touches HTTP. Putting them here is what makes "a thread cannot
 * message itself" a property of the mailbox rather than a property of one
 * transport.
 *
 * @module MailboxIntake
 */
import type { EnvironmentId, ThreadId, ThreadMailboxOrigin } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const MailboxIntakeFailureReason = Schema.Literals([
  "thread_not_found",
  "self_delivery",
  "lookup_failed",
]);
export type MailboxIntakeFailureReason = typeof MailboxIntakeFailureReason.Type;

export class MailboxIntakeError extends Schema.TaggedErrorClass<MailboxIntakeError>()(
  "MailboxIntakeError",
  {
    reason: MailboxIntakeFailureReason,
    threadId: Schema.String,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Mailbox delivery to thread ${this.threadId} refused: ${this.reason}.`;
  }
}

export interface MailboxIntakeCheck {
  readonly threadId: ThreadId;
  readonly origin: ThreadMailboxOrigin;
  readonly environmentId: EnvironmentId;
  /**
   * Passed in rather than pulled from context so callers resolve it once when
   * their service is built, and this stays a plain effect with no requirements
   * of its own.
   */
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
}

/**
 * Both checks are on identity rather than on the sender choosing to behave, so
 * an agent cannot be talked into either failure mode. Self-delivery is compared
 * on environment *and* thread, because thread ids are only unique per machine
 * and two machines could legitimately hold the same id.
 */
export const checkMailboxDelivery = Effect.fn("mailbox.checkDelivery")(function* (
  check: MailboxIntakeCheck,
): Effect.fn.Return<void, MailboxIntakeError> {
  if (
    check.origin.threadId === check.threadId &&
    check.origin.environmentId === check.environmentId
  ) {
    return yield* new MailboxIntakeError({
      reason: "self_delivery",
      threadId: check.threadId,
      detail: "A thread cannot deliver to its own mailbox.",
    });
  }

  const thread = yield* check.projectionSnapshotQuery
    .getThreadShellById(check.threadId)
    .pipe(
      Effect.mapError(
        () => new MailboxIntakeError({ reason: "lookup_failed", threadId: check.threadId }),
      ),
    );
  if (Option.isNone(thread)) {
    return yield* new MailboxIntakeError({ reason: "thread_not_found", threadId: check.threadId });
  }
});
