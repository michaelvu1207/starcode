/**
 * Records whether a user message came from the operator or from another agent.
 *
 * Both wear the `user` role, because to the provider they are the same kind of
 * thing, and until now the only way to tell them apart was to look for the
 * mailbox envelope's opening tag in the message text. Two separate consumers —
 * the first-turn titler and the snooze rule — had to perform that check and
 * agree about it, which is a string comparison standing in for a fact the row
 * should carry.
 *
 * Existing rows are backfilled to `operator`, and unlike the title-source
 * backfill this is not a choice between two wrong answers: agent-delivered
 * messages could not be persisted as user messages before immediate delivery
 * existed, so every row already in this table genuinely is the operator's.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "authored_by")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN authored_by TEXT NOT NULL DEFAULT 'operator'
    `;
  }
});
