import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_DropThreadSettleSnooze", (it) => {
  it.effect("drops the projection columns and clears the legacy lifecycle events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });

      // A database recorded before the feature was removed: two settle/snooze
      // events, and one ordinary event that must survive.
      const event = (sequence: number, id: string, eventType: string) => sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          actor_kind,
          command_id,
          causation_event_id,
          correlation_id,
          payload_json,
          metadata_json
        )
        VALUES (
          ${sequence},
          ${id},
          'thread',
          'thread-1',
          ${sequence},
          ${eventType},
          '2026-01-01T00:00:00.000Z',
          'client',
          ${`cmd-${id}`},
          NULL,
          ${`cmd-${id}`},
          '{}',
          '{}'
        )
      `;
      yield* event(1, "evt-archived", "thread.archived");
      yield* event(2, "evt-settled", "thread.settled");
      yield* event(3, "evt-snoozed", "thread.snoozed");

      yield* runMigrations({ toMigrationInclusive: 39 });

      // The event log is what the store replays on every boot, and the four
      // legacy types no longer decode — a survivor would fail the whole read
      // rather than be skipped.
      const remaining = yield* sql<{ readonly eventType: string }>`
        SELECT event_type AS "eventType" FROM orchestration_events ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(
        remaining.map((row) => row.eventType),
        ["thread.archived"],
      );

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      for (const dropped of ["settled_override", "settled_at", "snoozed_until", "snoozed_at"]) {
        assert.strictEqual(names.has(dropped), false, `${dropped} should be gone`);
      }
      // The rest of the row is untouched.
      assert.strictEqual(names.has("archived_at"), true);
    }),
  );
});
