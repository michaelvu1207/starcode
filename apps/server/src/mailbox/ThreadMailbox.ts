/**
 * ThreadMailbox - messages waiting for a thread's next turn.
 *
 * The guarantee this module exists to provide is that a message is delivered
 * **at most once**, and that it never causes a turn. Both fall out of one
 * design choice: the claim is a single `UPDATE ... RETURNING` that stamps
 * `delivered_at` and hands back exactly the rows it stamped. Two turns racing
 * on the same thread cannot both win a row, because the second one's `WHERE
 * delivered_at IS NULL` no longer matches. There is no read-then-write window
 * to lose.
 *
 * The honest cost of claiming before sending: if the provider turn fails after
 * the claim, those messages are marked delivered and the recipient never saw
 * them. That is the deliberate trade — a duplicate delivery is an agent acting
 * twice on the same instruction, which is worse than a dropped notification
 * that the sender can repeat.
 *
 * This is a store and nothing more. The two structural refusals that need to
 * know about the wider world — "does that thread exist" and "is a thread
 * talking to itself" — live in `intake.ts`, so both the HTTP route and the
 * local send path apply the identical rules without this module having to
 * depend on the projection or on the environment identity.
 *
 * @module ThreadMailbox
 */
import {
  MAILBOX_PENDING_MAX,
  type ThreadId,
  type ThreadMailboxEntry,
  type ThreadMailboxOrigin,
} from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const ThreadMailboxFailureReason = Schema.Literals(["mailbox_full", "store"]);
export type ThreadMailboxFailureReason = typeof ThreadMailboxFailureReason.Type;

export class ThreadMailboxError extends Schema.TaggedErrorClass<ThreadMailboxError>()(
  "ThreadMailboxError",
  {
    reason: ThreadMailboxFailureReason,
    threadId: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Mailbox operation on thread ${this.threadId} failed: ${this.reason}.`;
  }
}

export interface ThreadMailboxEnqueueInput {
  readonly threadId: ThreadId;
  readonly message: string;
  readonly origin: ThreadMailboxOrigin;
  readonly sentAt: string;
}

export interface ThreadMailboxShape {
  /**
   * Accepts a message for later delivery. Never starts a turn, never notifies
   * anything: the only observable effect is that the thread's next turn will
   * carry it.
   */
  readonly enqueue: (
    input: ThreadMailboxEnqueueInput,
  ) => Effect.Effect<
    { readonly entry: ThreadMailboxEntry; readonly pending: number },
    ThreadMailboxError
  >;
  /** Undelivered entries, oldest first. Read-only — does not claim. */
  readonly pending: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadMailboxEntry>, ThreadMailboxError>;
  /**
   * Atomically claims every undelivered entry for a thread. Called once at
   * turn start; the caller owns whatever it claims.
   */
  readonly claimForTurn: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadMailboxEntry>, ThreadMailboxError>;
}

export class ThreadMailbox extends Context.Service<ThreadMailbox, ThreadMailboxShape>()(
  "starcode/mailbox/ThreadMailbox",
) {}

interface MailboxRow {
  /**
   * SQLite's implicit insertion counter. Two messages sent in the same
   * millisecond share a `received_at`, so this is what actually orders a
   * mailbox — an agent reading "do A, then B" must not see them reversed.
   */
  readonly row_seq?: number;
  readonly entry_id: string;
  readonly thread_id: string;
  readonly message: string;
  readonly origin_environment_id: string | null;
  readonly origin_environment_label: string | null;
  readonly origin_thread_id: string | null;
  readonly origin_thread_title: string | null;
  readonly sent_at: string;
  readonly received_at: string;
  readonly delivered_at: string | null;
}

const toEntry = (row: MailboxRow): ThreadMailboxEntry =>
  ({
    entryId: row.entry_id,
    threadId: row.thread_id,
    message: row.message,
    origin: {
      environmentId: row.origin_environment_id,
      environmentLabel: row.origin_environment_label,
      threadId: row.origin_thread_id,
      threadTitle: row.origin_thread_title,
    },
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    deliveredAt: row.delivered_at,
  }) as ThreadMailboxEntry;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const storeFailure = (threadId: string, detail: string) => (cause: unknown) =>
    new ThreadMailboxError({ reason: "store", threadId, detail, cause });

  const pending: ThreadMailboxShape["pending"] = Effect.fn("ThreadMailbox.pending")(
    function* (threadId) {
      const rows = yield* sql<MailboxRow>`
        SELECT rowid AS row_seq, * FROM fork_thread_mailbox
        WHERE thread_id = ${threadId} AND delivered_at IS NULL
        ORDER BY rowid ASC
      `.pipe(Effect.mapError(storeFailure(threadId, "read pending mailbox entries")));
      return rows.map(toEntry);
    },
  );

  const enqueue: ThreadMailboxShape["enqueue"] = Effect.fn("ThreadMailbox.enqueue")(
    function* (input) {
      const backlog = yield* pending(input.threadId);
      if (backlog.length >= MAILBOX_PENDING_MAX) {
        return yield* new ThreadMailboxError({
          reason: "mailbox_full",
          threadId: input.threadId,
          detail: `Thread already has ${backlog.length} undelivered messages.`,
        });
      }

      const entryId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const receivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

      yield* sql`
        INSERT INTO fork_thread_mailbox (
          entry_id, thread_id, message,
          origin_environment_id, origin_environment_label,
          origin_thread_id, origin_thread_title,
          sent_at, received_at, delivered_at
        ) VALUES (
          ${entryId}, ${input.threadId}, ${input.message},
          ${input.origin.environmentId}, ${input.origin.environmentLabel},
          ${input.origin.threadId}, ${input.origin.threadTitle},
          ${input.sentAt}, ${receivedAt}, NULL
        )
      `.pipe(Effect.mapError(storeFailure(input.threadId, "insert mailbox entry")));

      return {
        entry: toEntry({
          entry_id: entryId,
          thread_id: input.threadId,
          message: input.message,
          origin_environment_id: input.origin.environmentId,
          origin_environment_label: input.origin.environmentLabel,
          origin_thread_id: input.origin.threadId,
          origin_thread_title: input.origin.threadTitle,
          sent_at: input.sentAt,
          received_at: receivedAt,
          delivered_at: null,
        }),
        pending: backlog.length + 1,
      };
    },
  );

  const claimForTurn: ThreadMailboxShape["claimForTurn"] = Effect.fn("ThreadMailbox.claimForTurn")(
    function* (threadId) {
      const deliveredAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // One statement, so the stamp and the read cannot be separated. Whatever
      // comes back is this turn's alone.
      const rows = yield* sql<MailboxRow>`
        UPDATE fork_thread_mailbox
        SET delivered_at = ${deliveredAt}
        WHERE thread_id = ${threadId} AND delivered_at IS NULL
        RETURNING rowid AS row_seq, *
      `.pipe(Effect.mapError(storeFailure(threadId, "claim mailbox entries")));
      // `RETURNING` makes no ordering promise, so send order is restored here.
      return rows
        .toSorted((left, right) => (left.row_seq ?? 0) - (right.row_seq ?? 0))
        .map(toEntry);
    },
  );

  return { enqueue, pending, claimForTurn } satisfies ThreadMailboxShape;
});

export const layer: Layer.Layer<ThreadMailbox, never, SqlClient.SqlClient | Crypto.Crypto> =
  Layer.effect(ThreadMailbox, make);
