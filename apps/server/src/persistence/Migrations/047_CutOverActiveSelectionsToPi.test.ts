import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeSqliteClient.layerMemory())("active Pi cutover migration", (it) => {
  it.effect("moves launch selectors to Pi while preserving historical runtime attribution", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      const at = "2026-08-04T08:00:00.000Z";

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          default_model_selection_json
        ) VALUES (
          'project-legacy', 'Legacy', '/tmp/legacy', '[]', ${at}, ${at},
          '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"max"}]}'
        )
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          default_model_selection_json
        ) VALUES (
          'project-custom-legacy', 'Custom legacy', '/tmp/custom-legacy', '[]', ${at}, ${at},
          '{"instanceId":"work-account","model":"claude-fable-5"}'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, model_selection_json
        ) VALUES
        (
          'thread-legacy', 'project-legacy', 'Legacy', ${at}, ${at},
          '{"instanceId":"claudeAgent","model":"claude-opus-5","options":[{"id":"contextWindow","value":"1m"},{"id":"effort","value":"high"}]}'
        ),
        (
          'thread-pi', 'project-legacy', 'Pi', ${at}, ${at},
          '{"instanceId":"pi-live","model":"anthropic/claude-fable-5","options":[{"id":"context","value":"600k"}]}'
        ),
        (
          'thread-custom-legacy', 'project-custom-legacy', 'Custom legacy', ${at}, ${at},
          '{"instanceId":"work-account","model":"claude-fable-5"}'
        ),
        (
          'thread-custom-unbound', 'project-custom-legacy', 'Custom unbound', ${at}, ${at},
          '{"instanceId":"codex_personal","model":"gpt-5.6-sol"}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-legacy', 'thread', 'thread-legacy', 1, 'thread.created', ${at},
          'user',
          '{"threadId":"thread-legacy","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5"}}',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at,
          resume_cursor_json, runtime_payload_json, provider_instance_id
        ) VALUES
        (
          'thread-legacy', 'claudeAgent', 'claudeAgent', 'full-access', 'running', ${at},
          '{"resume":"native-claude-session"}',
          '{"cwd":"/tmp/legacy","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5"}}',
          'claudeAgent'
        ),
        (
          'thread-pi', 'pi', 'pi', 'full-access', 'running', ${at},
          '{"sessionFile":"/tmp/pi.jsonl","sessionId":"pi-session"}',
          '{"cwd":"/tmp/legacy"}',
          'pi'
        ),
        (
          'thread-custom-legacy', 'claudeAgent', 'claudeAgent', 'full-access', 'running', ${at},
          '{"resume":"native-custom-claude-session"}',
          '{"cwd":"/tmp/custom-legacy"}',
          'work-account'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const projects = yield* sql<{ readonly project_id: string; readonly selection: string }>`
        SELECT project_id, default_model_selection_json AS selection
        FROM projection_projects ORDER BY project_id
      `;
      assert.deepEqual(
        projects.map((project) => [project.project_id, decodeJson(project.selection)]),
        [
          ["project-custom-legacy", { instanceId: "pi", model: "anthropic/claude-fable-5" }],
          [
            "project-legacy",
            {
              instanceId: "pi",
              model: "openai-codex/gpt-5.6-sol",
              options: [{ id: "effort", value: "xhigh" }],
            },
          ],
        ],
      );

      const threads = yield* sql<{ readonly thread_id: string; readonly selection: string }>`
        SELECT thread_id, model_selection_json AS selection
        FROM projection_threads ORDER BY thread_id
      `;
      assert.deepEqual(
        threads.map((row) => [row.thread_id, decodeJson(row.selection)]),
        [
          [
            "thread-custom-legacy",
            {
              instanceId: "work-account",
              model: "claude-fable-5",
            },
          ],
          [
            "thread-custom-unbound",
            {
              instanceId: "pi",
              model: "openai-codex/gpt-5.6-sol",
            },
          ],
          [
            "thread-legacy",
            {
              instanceId: "claudeAgent",
              model: "claude-opus-5",
              options: [
                { id: "contextWindow", value: "1m" },
                { id: "effort", value: "high" },
              ],
            },
          ],
          [
            "thread-pi",
            {
              instanceId: "pi-live",
              model: "anthropic/claude-fable-5",
              options: [{ id: "context", value: "600k" }],
            },
          ],
        ],
      );

      const [event] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events WHERE event_id = 'event-legacy'
      `;
      assert.deepEqual(decodeJson(event!.payload_json), {
        threadId: "thread-legacy",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      });

      const runtime = yield* sql<{
        readonly thread_id: string;
        readonly provider_name: string;
        readonly provider_instance_id: string;
        readonly status: string;
        readonly resume_cursor_json: string;
        readonly runtime_payload_json: string;
      }>`
        SELECT thread_id, provider_name, provider_instance_id, status,
          resume_cursor_json, runtime_payload_json
        FROM provider_session_runtime ORDER BY thread_id
      `;
      assert.deepEqual(runtime, [
        {
          thread_id: "thread-custom-legacy",
          provider_name: "claudeAgent",
          provider_instance_id: "work-account",
          status: "stopped",
          resume_cursor_json: '{"resume":"native-custom-claude-session"}',
          runtime_payload_json: '{"cwd":"/tmp/custom-legacy"}',
        },
        {
          thread_id: "thread-legacy",
          provider_name: "claudeAgent",
          provider_instance_id: "claudeAgent",
          status: "stopped",
          resume_cursor_json: '{"resume":"native-claude-session"}',
          runtime_payload_json:
            '{"cwd":"/tmp/legacy","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-5"}}',
        },
        {
          thread_id: "thread-pi",
          provider_name: "pi",
          provider_instance_id: "pi",
          status: "running",
          resume_cursor_json: '{"sessionFile":"/tmp/pi.jsonl","sessionId":"pi-session"}',
          runtime_payload_json: '{"cwd":"/tmp/legacy"}',
        },
      ]);
    }),
  );
});
