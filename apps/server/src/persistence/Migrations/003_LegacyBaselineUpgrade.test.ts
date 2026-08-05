import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("legacy Pi baseline upgrade", (it) => {
  it.effect("preserves baseline history and maps provider-specific session rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The b380 baseline recorded ids 1 and 2, so the replacement migrator
      // begins at migration 3 even though most of the schema already exists.
      yield* runMigrations({ toMigrationInclusive: 2 });
      yield* sql`UPDATE effect_sql_migrations SET name = 'Baseline' WHERE migration_id = 1`;
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'EnsurePiSubscriptionUsage'
        WHERE migration_id = 2
      `;

      yield* sql`
        CREATE TABLE pi_session_runtime (
          thread_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access',
          status TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resume_cursor_json TEXT,
          runtime_payload_json TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          scripts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          default_model_selection_json TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          latest_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access',
          interaction_mode TEXT NOT NULL DEFAULT 'default',
          model_selection_json TEXT,
          archived_at TEXT,
          latest_user_message_at TEXT,
          pending_approval_count INTEGER NOT NULL DEFAULT 0,
          pending_user_input_count INTEGER NOT NULL DEFAULT 0,
          has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0,
          title_source TEXT NOT NULL DEFAULT 'generated',
          side_of_thread_id TEXT,
          goal_json TEXT,
          parent_thread_id TEXT,
          home_node TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_thread_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          is_streaming INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          attachments_json TEXT,
          authored_by TEXT NOT NULL DEFAULT 'operator'
        )
      `;
      yield* sql`
        CREATE TABLE projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          tone TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sequence INTEGER
        )
      `;
      yield* sql`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          account_id TEXT NOT NULL,
          model TEXT NOT NULL,
          pi_session_id TEXT,
          active_turn_id TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access'
        )
      `;
      yield* sql`
        CREATE TABLE projection_turns (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          pending_message_id TEXT,
          assistant_message_id TEXT,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          checkpoint_turn_count INTEGER,
          checkpoint_ref TEXT,
          checkpoint_status TEXT,
          checkpoint_files_json TEXT NOT NULL,
          source_proposed_plan_thread_id TEXT,
          source_proposed_plan_id TEXT,
          UNIQUE (thread_id, turn_id),
          UNIQUE (thread_id, checkpoint_turn_count)
        )
      `;
      yield* sql`
        CREATE TABLE projection_pending_approvals (
          request_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          status TEXT NOT NULL,
          decision TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_state (
          projector TEXT PRIMARY KEY,
          last_applied_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE projection_thread_proposed_plans (
          plan_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          plan_markdown TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          implemented_at TEXT,
          implementation_thread_id TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_agent_runs (
          parent_thread_id TEXT NOT NULL,
          agent_run_id TEXT NOT NULL,
          launch_tool_use_id TEXT,
          task_type TEXT,
          agent_type TEXT,
          model TEXT,
          description TEXT,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          transcript_state TEXT NOT NULL,
          PRIMARY KEY (parent_thread_id, agent_run_id)
        )
      `;
      yield* sql`
        CREATE INDEX idx_projection_agent_runs_parent_status
        ON projection_agent_runs(parent_thread_id, status, updated_at)
      `;

      const at = "2026-07-30T12:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          default_model_selection_json
        ) VALUES (
          'project-legacy', 'Legacy project', '/tmp/legacy', '{}', ${at}, ${at},
          '{"provider":"pi","model":"pi/model"}'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, model_selection_json
        ) VALUES (
          'thread-legacy', 'project-legacy', 'Legacy thread', ${at}, ${at},
          '{"provider":"pi","model":"pi/model"}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('message-legacy', 'thread-legacy', 'user', 'preserve me', 0, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO pi_session_runtime (
          thread_id, account_id, runtime_mode, status, last_seen_at,
          resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-legacy', 'pi-account', 'full-access', 'running', ${at},
          '{"cursor":"legacy"}', '{"payload":"legacy"}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, account_id, model, pi_session_id, updated_at, runtime_mode
        ) VALUES (
          'thread-legacy', 'running', 'pi-account', 'pi/model', 'pi-session', ${at},
          'full-access'
        )
      `;
      yield* sql`
        INSERT INTO projection_agent_runs (
          parent_thread_id, agent_run_id, task_type, agent_type, model, description,
          status, started_at, updated_at, transcript_state
        ) VALUES (
          'thread-legacy', 'agent-legacy', 'agent', 'explore', 'pi/model',
          'preserve agent', 'completed', ${at}, ${at}, 'unavailable'
        )
      `;

      yield* runMigrations();
      yield* runMigrations();

      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepEqual(
        applied.map((row) => row.migration_id),
        migrationEntries.map(([id]) => id),
      );

      const runtime = yield* sql<{
        readonly provider_name: string;
        readonly provider_instance_id: string;
        readonly adapter_key: string;
        readonly resume_cursor_json: string;
        readonly runtime_payload_json: string;
      }>`
        SELECT provider_name, provider_instance_id, adapter_key,
          resume_cursor_json, runtime_payload_json
        FROM provider_session_runtime
        WHERE thread_id = 'thread-legacy'
      `;
      assert.deepEqual(runtime, [
        {
          provider_name: "pi",
          provider_instance_id: "pi-account",
          adapter_key: "pi",
          resume_cursor_json: '{"cursor":"legacy"}',
          runtime_payload_json: '{"payload":"legacy"}',
        },
      ]);

      const session = yield* sql<{
        readonly provider_name: string;
        readonly provider_instance_id: string;
        readonly provider_session_id: string;
        readonly provider_thread_id: string;
      }>`
        SELECT provider_name, provider_instance_id, provider_session_id, provider_thread_id
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-legacy'
      `;
      assert.deepEqual(session, [
        {
          provider_name: "pi",
          provider_instance_id: "pi-account",
          provider_session_id: "pi-session",
          provider_thread_id: "pi-session",
        },
      ]);

      const preserved = yield* sql<{
        readonly project_count: number;
        readonly thread_count: number;
        readonly message_text: string;
      }>`
        SELECT
          (SELECT count(*) FROM projection_projects WHERE project_id = 'project-legacy')
            AS project_count,
          (SELECT count(*) FROM projection_threads WHERE thread_id = 'thread-legacy')
            AS thread_count,
          (SELECT text FROM projection_thread_messages WHERE message_id = 'message-legacy')
            AS message_text
      `;
      assert.deepEqual(preserved, [
        { project_count: 1, thread_count: 1, message_text: "preserve me" },
      ]);

      const agentRuns = yield* sql<{
        readonly provider: string;
        readonly agent_run_id: string;
        readonly description: string;
        readonly status: string;
        readonly transcript_state: string;
      }>`
        SELECT provider, agent_run_id, description, status, transcript_state
        FROM projection_agent_runs
        WHERE parent_thread_id = 'thread-legacy'
      `;
      assert.deepEqual(agentRuns, [
        {
          provider: "pi",
          agent_run_id: "agent-legacy",
          description: "preserve agent",
          status: "completed",
          transcript_state: "unavailable",
        },
      ]);

      const legacyTables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'pi_session_runtime',
            'legacy_pi_thread_sessions',
            'legacy_pi_projection_agent_runs'
          )
      `;
      assert.deepEqual(legacyTables, []);
    }),
  );
});
