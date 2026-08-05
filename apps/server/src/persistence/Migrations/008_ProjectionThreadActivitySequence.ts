import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_activities)
  `;

  if (!columns.some((column) => column.name === "sequence")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN sequence INTEGER
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence
    ON projection_thread_activities(thread_id, sequence)
  `;
});
