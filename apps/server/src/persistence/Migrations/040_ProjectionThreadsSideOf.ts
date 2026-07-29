/**
 * Records which thread a side thread was opened beside.
 *
 * Nullable with no default, and that is the whole design: NULL means "an
 * ordinary thread", which is what every existing row is and what every future
 * row will be unless `/side` created it. So there is no backfill to get wrong —
 * unlike `037_ProjectionThreadsTitleSource`, whose backfill had to pick between
 * two wrong answers, this one has a correct answer for the entire backlog.
 *
 * Deliberately not a foreign key onto `projection_threads(thread_id)`. A side
 * thread outlives its parent by design in exactly one case worth caring about —
 * the parent is deleted while the side panel is open — and a constraint would
 * turn that into a failed delete of the *parent*, which is the thread the user
 * actually asked to remove. The dangling id then reads as "side of a thread
 * that is gone", which the client already has to render for a parent on a
 * disconnected machine.
 *
 * Indexed because the sidebar's hot query is "the listable threads in this
 * project", and after this migration that predicate is
 * `archived_at IS NULL AND side_of_thread_id IS NULL`. A partial index on the
 * NULL case keeps that scan the size it was before side threads existed, rather
 * than proportional to how many scratch conversations have been opened.
 *
 * Numbered 040 rather than 039 to leave that slot to the settle/snooze removal
 * landing in parallel. Gaps are fine — `migrationEntries` is an explicit list
 * sorted by id, not a dense range.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "side_of_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN side_of_thread_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_threads_listable
    ON projection_threads (project_id, updated_at)
    WHERE archived_at IS NULL AND side_of_thread_id IS NULL
  `;
});
