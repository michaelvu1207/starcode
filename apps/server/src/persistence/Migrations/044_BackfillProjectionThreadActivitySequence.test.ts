import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_BackfillProjectionThreadActivitySequence", (it) => {
  it.effect("backfills the event sequence for existing projected activities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          'event-activity-sequence-backfill',
          'thread',
          'thread-activity-sequence-backfill',
          1,
          'thread.activity-appended',
          '2026-08-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          'system',
          '{"threadId":"thread-activity-sequence-backfill","activity":{"id":"activity-sequence-backfill"}}',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        ) VALUES (
          'activity-sequence-backfill',
          'thread-activity-sequence-backfill',
          NULL,
          'tool',
          'tool.completed',
          'bash',
          '{}',
          NULL,
          '2026-08-01T00:00:00.000Z'
        )
      `;
      const eventRows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = 'event-activity-sequence-backfill'
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const activityRows = yield* sql<{ readonly sequence: number | null }>`
        SELECT sequence
        FROM projection_thread_activities
        WHERE activity_id = 'activity-sequence-backfill'
      `;
      assert.deepEqual(activityRows, [{ sequence: eventRows[0]!.sequence }]);
    }),
  );
});
