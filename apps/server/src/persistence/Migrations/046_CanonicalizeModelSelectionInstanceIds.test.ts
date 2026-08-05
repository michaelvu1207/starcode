import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

it.layer(NodeSqliteClient.layerMemory())("model selection instance id migration", (it) => {
  it.effect("canonicalizes projection and event selectors without dropping options", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });

      const at = "2026-08-04T08:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          default_model_selection_json
        ) VALUES (
          'project-account', 'Account selector', '/tmp/account', '[]', ${at}, ${at},
          '{"model":"gpt-5.4","accountId":"codex","options":[{"id":"effort","value":"high"}]}'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, model_selection_json
        ) VALUES
        (
          'thread-provider', 'project-account', 'Provider selector', ${at}, ${at},
          '{"provider":"claudeAgent","model":"claude-opus-5","options":[{"id":"contextWindow","value":"1m"}]}'
        ),
        (
          'thread-canonical', 'project-account', 'Canonical selector', ${at}, ${at},
          '{"instanceId":"pi-live","accountId":"pi-old","provider":"pi","model":"openai/gpt-5.6-sol"}'
        )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
        (
          'event-project', 'project', 'project-account', 1, 'project.created', ${at},
          'user',
          '{"projectId":"project-account","defaultModelSelection":{"accountId":"codex","model":"gpt-5.4","options":[{"id":"effort","value":"high"}]},"untouched":"project"}',
          '{}'
        ),
        (
          'event-thread', 'thread', 'thread-provider', 1, 'thread.created', ${at},
          'user',
          '{"threadId":"thread-provider","modelSelection":{"provider":"claudeAgent","model":"claude-opus-5","options":[{"id":"contextWindow","value":"1m"}]},"untouched":"thread"}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 46 });

      const projects = yield* sql<{
        readonly selection: string;
      }>`
        SELECT default_model_selection_json AS selection
        FROM projection_projects
        WHERE project_id = 'project-account'
      `;
      assert.deepEqual(decodeJsonRecord(projects[0]!.selection), {
        model: "gpt-5.4",
        options: [{ id: "effort", value: "high" }],
        instanceId: "codex",
      });

      const threads = yield* sql<{
        readonly thread_id: string;
        readonly selection: string;
      }>`
        SELECT thread_id, model_selection_json AS selection
        FROM projection_threads
        WHERE thread_id IN ('thread-provider', 'thread-canonical')
        ORDER BY thread_id
      `;
      assert.deepEqual(
        threads.map((row) => [row.thread_id, decodeJsonRecord(row.selection)]),
        [
          ["thread-canonical", { instanceId: "pi-live", model: "openai/gpt-5.6-sol" }],
          [
            "thread-provider",
            {
              model: "claude-opus-5",
              options: [{ id: "contextWindow", value: "1m" }],
              instanceId: "claudeAgent",
            },
          ],
        ],
      );

      const events = yield* sql<{
        readonly event_id: string;
        readonly payload_json: string;
      }>`
        SELECT event_id, payload_json
        FROM orchestration_events
        WHERE event_id IN ('event-project', 'event-thread')
        ORDER BY event_id
      `;
      const payloads = Object.fromEntries(
        events.map((row) => [row.event_id, decodeJsonRecord(row.payload_json)]),
      );
      assert.deepEqual(payloads["event-project"], {
        projectId: "project-account",
        defaultModelSelection: {
          model: "gpt-5.4",
          options: [{ id: "effort", value: "high" }],
          instanceId: "codex",
        },
        untouched: "project",
      });
      assert.deepEqual(payloads["event-thread"], {
        threadId: "thread-provider",
        modelSelection: {
          model: "claude-opus-5",
          options: [{ id: "contextWindow", value: "1m" }],
          instanceId: "claudeAgent",
        },
        untouched: "thread",
      });
    }),
  );
});
