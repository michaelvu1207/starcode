import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const tableColumns = Effect.fn("legacyBaselineTableColumns")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
});

/**
 * Upgrade the short-lived Pi baseline that used provider-specific table and
 * column names. That baseline recorded migrations 1 and 2, so this bridge has
 * to run at the beginning of migration 3, before the generic projection
 * migrations encounter the already-present tables.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const piRuntimeColumns = yield* tableColumns("pi_session_runtime");
  if (piRuntimeColumns.has("account_id")) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS provider_session_runtime (
        thread_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        provider_instance_id TEXT,
        adapter_key TEXT NOT NULL,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resume_cursor_json TEXT,
        runtime_payload_json TEXT
      )
    `;
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id,
        provider_name,
        provider_instance_id,
        adapter_key,
        runtime_mode,
        status,
        last_seen_at,
        resume_cursor_json,
        runtime_payload_json
      )
      SELECT
        thread_id,
        'pi',
        account_id,
        'pi',
        runtime_mode,
        status,
        last_seen_at,
        resume_cursor_json,
        runtime_payload_json
      FROM pi_session_runtime
      WHERE true
      ON CONFLICT(thread_id) DO UPDATE SET
        provider_name = excluded.provider_name,
        provider_instance_id = excluded.provider_instance_id,
        adapter_key = excluded.adapter_key,
        runtime_mode = excluded.runtime_mode,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        resume_cursor_json = excluded.resume_cursor_json,
        runtime_payload_json = excluded.runtime_payload_json
    `;
    yield* sql`DROP TABLE pi_session_runtime`;
  }

  const sessionColumns = yield* tableColumns("projection_thread_sessions");
  if (sessionColumns.has("account_id") && !sessionColumns.has("provider_name")) {
    // Keep the canonical thread selection populated when a baseline row is the
    // only surviving record of the model that launched the Pi session.
    yield* sql`
      UPDATE projection_threads
      SET model_selection_json = coalesce(
        model_selection_json,
        (
          SELECT json_object('provider', 'pi', 'model', sessions.model)
          FROM projection_thread_sessions AS sessions
          WHERE sessions.thread_id = projection_threads.thread_id
        )
      )
      WHERE EXISTS (
        SELECT 1
        FROM projection_thread_sessions AS sessions
        WHERE sessions.thread_id = projection_threads.thread_id
      )
    `;

    yield* sql`ALTER TABLE projection_thread_sessions RENAME TO legacy_pi_thread_sessions`;
    yield* sql`
      CREATE TABLE projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_instance_id TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        provider_session_id,
        provider_thread_id,
        active_turn_id,
        last_error,
        updated_at,
        runtime_mode
      )
      SELECT
        thread_id,
        status,
        'pi',
        account_id,
        pi_session_id,
        pi_session_id,
        active_turn_id,
        last_error,
        updated_at,
        runtime_mode
      FROM legacy_pi_thread_sessions
    `;
    yield* sql`DROP TABLE legacy_pi_thread_sessions`;
  }
});
