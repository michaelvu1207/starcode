/**
 * Drops thread settle/snooze, which the product no longer has.
 *
 * Two halves, and the second is the one that matters. Dropping the four
 * projection columns is cosmetic — nothing reads them any more. Deleting the
 * `thread.settled` / `thread.unsettled` / `thread.snoozed` / `thread.unsnoozed`
 * rows from the event log is not: those types are gone from the event schema,
 * and the store decodes every row it replays, so a single surviving legacy row
 * would fail the whole read rather than be skipped. Deleting them is lossless
 * for everything that remains — their only effect was on state that no longer
 * exists — and the sequence gaps they leave are fine, because readers page by
 * `sequence >` a cursor rather than by contiguity.
 *
 * Migrations 033 and 034, which added the columns, stay where they are: the
 * list is append-only, and a fresh database still runs them before this one
 * takes the columns back out.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DROPPED_COLUMNS = ["settled_override", "settled_at", "snoozed_until", "snoozed_at"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM orchestration_events
    WHERE event_type IN (
      'thread.settled',
      'thread.unsettled',
      'thread.snoozed',
      'thread.unsnoozed'
    )
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const present = new Set(columns.map((column) => column.name));

  for (const column of DROPPED_COLUMNS) {
    if (!present.has(column)) continue;
    // Interpolated rather than bound: SQLite takes no parameter in a DDL
    // identifier position. The values are this module's own literals.
    yield* sql.unsafe(`ALTER TABLE projection_threads DROP COLUMN ${column}`);
  }
});
