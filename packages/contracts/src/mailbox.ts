/**
 * Per-thread mailbox — attributed messages that wait for a thread's next turn.
 *
 * The distinction that defines this module: enqueueing a mailbox message never
 * starts a turn. t3's only path for user text (`thread.turn.start`) always
 * emits a turn-start alongside the message, so agent-to-agent chatter over that
 * path would bill a turn per message and interrupt whatever the target was
 * doing. A mailbox entry instead sits in a table until the target thread turns
 * for its own reasons, and rides along with that turn's prompt.
 *
 * Delivery is framed as untrusted collaborator data because the sender is
 * another agent, not the operator, and every agent here can run shell commands.
 * The envelope carries provenance (which thread, which machine, when) and
 * nothing else — no behavioural instruction is shipped by the fork.
 *
 * @module Mailbox
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * A single message is capped well below a context window: a mailbox is for
 * coordination ("branch pushed, review it"), and anything longer belongs in a
 * thread the recipient can read with `peer_thread_read`.
 */
export const MAILBOX_MESSAGE_MAX_CHARS = 4_000;

/**
 * Per-thread ceiling on undelivered entries. A thread that has not turned in a
 * long time must not accumulate an unbounded backlog that then lands in one
 * prompt; past this point the oldest entries are the ones kept and new sends
 * are refused, so the sender learns immediately rather than being silently
 * dropped.
 */
export const MAILBOX_PENDING_MAX = 25;

/**
 * The opening tag of the envelope agent-to-agent messages arrive in.
 *
 * Lives in contracts rather than beside the renderer because it is read far
 * from where it is written. An immediately-delivered message is persisted as an
 * ordinary user message, so anything deciding how to treat a stored message —
 * whether to generate a thread title from it — has to be able to tell that an
 * agent wrote it, and the event carries no authorship field to ask. Until it does, this prefix is the
 * marker, and every reader has to agree on it exactly.
 */
export const MAILBOX_ENVELOPE_PREFIX = "<mailbox-messages";

/**
 * Where a mailbox message came from. Every field is nullable because a sender
 * on an older or differently-configured server may not know its own label, and
 * a missing attribution must degrade to "unknown sender" rather than reject the
 * message.
 */
export const ThreadMailboxOrigin = Schema.Struct({
  environmentId: Schema.NullOr(EnvironmentId),
  environmentLabel: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadMailboxOrigin = typeof ThreadMailboxOrigin.Type;

export const ThreadMailboxSendInput = Schema.Struct({
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(MAILBOX_MESSAGE_MAX_CHARS)),
  origin: ThreadMailboxOrigin,
  /**
   * Stamped by the sender so provenance reflects when the sending agent wrote
   * it, not when the receiving server happened to persist it. The receiver
   * still records its own arrival time separately.
   */
  sentAt: IsoDateTime,
});
export type ThreadMailboxSendInput = typeof ThreadMailboxSendInput.Type;

export const ThreadMailboxSendResult = Schema.Struct({
  entryId: TrimmedNonEmptyString,
  threadId: ThreadId,
  /** Undelivered entries on the target thread after this one was accepted. */
  pending: NonNegativeInt,
});
export type ThreadMailboxSendResult = typeof ThreadMailboxSendResult.Type;

export const ThreadMailboxEntry = Schema.Struct({
  entryId: TrimmedNonEmptyString,
  threadId: ThreadId,
  message: Schema.String,
  origin: ThreadMailboxOrigin,
  sentAt: IsoDateTime,
  receivedAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type ThreadMailboxEntry = typeof ThreadMailboxEntry.Type;

export const ThreadMailboxListResult = Schema.Struct({
  threadId: ThreadId,
  pending: Schema.Array(ThreadMailboxEntry),
});
export type ThreadMailboxListResult = typeof ThreadMailboxListResult.Type;
