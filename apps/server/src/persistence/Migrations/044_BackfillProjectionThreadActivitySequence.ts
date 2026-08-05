import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Restore canonical event ordering for activity rows written without a sequence. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Extract the JSON identity once, then index it. A correlated JSON scan for
  // every projected activity makes startup quadratic on established databases.
  yield* sql`
    CREATE TEMP TABLE projection_activity_sequence_backfill AS
    SELECT
      stream_id AS thread_id,
      json_extract(payload_json, '$.activity.id') AS activity_id,
      MAX(sequence) AS sequence
    FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.id') IS NOT NULL
    GROUP BY stream_id, json_extract(payload_json, '$.activity.id')
  `;
  yield* sql`
    CREATE UNIQUE INDEX projection_activity_sequence_backfill_identity
    ON projection_activity_sequence_backfill (thread_id, activity_id)
  `;
  yield* sql`
    UPDATE projection_thread_activities AS activity
    SET sequence = (
      SELECT backfill.sequence
      FROM projection_activity_sequence_backfill AS backfill
      WHERE backfill.thread_id = activity.thread_id
        AND backfill.activity_id = activity.activity_id
    )
    WHERE activity.sequence IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_activity_sequence_backfill AS backfill
        WHERE backfill.thread_id = activity.thread_id
          AND backfill.activity_id = activity.activity_id
      )
  `;
  yield* sql`DROP TABLE projection_activity_sequence_backfill`;
});
