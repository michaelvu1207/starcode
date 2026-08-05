/**
 * Records who last named a thread, so an automatic rename can avoid overwriting
 * a person's.
 *
 * Existing rows are backfilled to `generated` rather than `manual`. Their real
 * provenance is unknowable — nothing recorded it — so this is a choice between
 * two wrong answers, and `generated` is the less wrong one: the first-turn
 * titler runs on every thread, so it is what almost all of these titles are,
 * and the failure mode is a recoverable one-time rename of a thread somebody
 * had renamed by hand. Backfilling `manual` would instead make the feature
 * silently dead for the entire existing backlog, which is the failure nobody
 * would think to report.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "title_source")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_source TEXT NOT NULL DEFAULT 'generated'
    `;
  }
});
