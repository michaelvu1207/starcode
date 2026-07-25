/**
 * Fork migration: per-thread mailbox.
 *
 * One row per message left for a thread by another agent. Rows are not deleted
 * on delivery, they are stamped: `delivered_at` is what makes delivery
 * exactly-once, and keeping the delivered rows means "what was this thread
 * told, and by whom" is answerable after the fact — which is the whole reason
 * to attribute the messages in the first place.
 *
 * Provenance is stored as four flat columns rather than a JSON blob because
 * every one of them is nullable and independently queryable ("everything that
 * machine sent us"), and because a blob would need a decode step on a path that
 * runs at the start of every turn.
 *
 * Written idempotently on purpose — fork migrations get renumbered above
 * upstream's on every merge and therefore re-run. See NOTES-mapper-addendum
 * section 7.4.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_mailbox (
      entry_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message TEXT NOT NULL,
      origin_environment_id TEXT,
      origin_environment_label TEXT,
      origin_thread_id TEXT,
      origin_thread_title TEXT,
      sent_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;

  // The hot read is "undelivered entries for this thread, oldest first", run
  // at the start of every turn on every thread. A partial index keeps it
  // proportional to the backlog rather than to the delivery history, which is
  // the part that grows without bound.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_thread_mailbox_pending
    ON fork_thread_mailbox (thread_id, received_at)
    WHERE delivered_at IS NULL
  `;
});
