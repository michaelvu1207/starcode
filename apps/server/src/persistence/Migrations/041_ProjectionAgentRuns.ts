import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable, thread-owned provider agent runs and append-only native parent
 * session evidence.
 *
 * The backfill reads the append-only orchestration log rather than relying on
 * another projection's checkpoint. It folds only explicit agent evidence,
 * carries terminal lifecycle rows that omit taskType through the stable
 * thread/task identity, and checkpoints the new projector at the exact event
 * tip observed in this migration transaction. Without that checkpoint a large
 * installation would replay the entire log one transaction per event before
 * current agents became visible.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_agent_runs (
      parent_thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      agent_run_id TEXT NOT NULL,
      launch_tool_use_id TEXT,
      task_type TEXT,
      agent_type TEXT,
      model TEXT,
      description TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      history_session_id TEXT,
      transcript_state TEXT NOT NULL,
      parent_native_session_id TEXT,
      PRIMARY KEY (parent_thread_id, provider, agent_run_id)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_agent_runs_history_owner
    ON projection_agent_runs (history_session_id)
    WHERE history_session_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_runs_parent_status
    ON projection_agent_runs (parent_thread_id, status, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_native_sessions (
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, provider, native_session_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_native_sessions_thread
    ON projection_thread_native_sessions (thread_id, provider)
  `;

  // Replace any rows left by a previously interrupted local experiment. The
  // migration is the ownership cutover and its event-log fold is deterministic.
  yield* sql`DELETE FROM projection_agent_runs`;

  yield* sql`
    WITH
    task_events AS MATERIALIZED (
      SELECT
        events.sequence,
        json_extract(events.payload_json, '$.threadId') AS parent_thread_id,
        json_extract(events.payload_json, '$.activity.kind') AS activity_kind,
        json_extract(events.payload_json, '$.activity.createdAt') AS created_at,
        json_extract(events.payload_json, '$.activity.payload.taskId') AS agent_run_id,
        lower(
          replace(
            coalesce(json_extract(events.payload_json, '$.activity.payload.taskType'), ''),
            '-',
            '_'
          )
        ) AS normalized_task_type,
        nullif(trim(json_extract(events.payload_json, '$.activity.payload.taskType')), '')
          AS task_type,
        nullif(trim(json_extract(events.payload_json, '$.activity.payload.toolUseId')), '')
          AS launch_tool_use_id,
        nullif(trim(json_extract(events.payload_json, '$.activity.payload.subagentType')), '')
          AS agent_type,
        nullif(trim(json_extract(events.payload_json, '$.activity.payload.model')), '')
          AS model,
        coalesce(
          nullif(trim(json_extract(events.payload_json, '$.activity.payload.title')), ''),
          nullif(trim(json_extract(events.payload_json, '$.activity.payload.detail')), ''),
          nullif(trim(json_extract(events.payload_json, '$.activity.payload.description')), '')
        ) AS description,
        nullif(trim(json_extract(events.payload_json, '$.activity.payload.status')), '')
          AS lifecycle_status,
        CASE
          WHEN length(
            trim(json_extract(events.payload_json, '$.activity.payload.historySessionId'))
          ) = 32
            AND lower(
              trim(json_extract(events.payload_json, '$.activity.payload.historySessionId'))
            ) NOT GLOB '*[^0-9a-f]*'
          THEN lower(
            trim(json_extract(events.payload_json, '$.activity.payload.historySessionId'))
          )
          ELSE NULL
        END AS history_session_id,
        nullif(
          trim(json_extract(events.payload_json, '$.activity.payload.parentNativeSessionId')),
          ''
        ) AS parent_native_session_id
      FROM orchestration_events AS events
      WHERE events.event_type = 'thread.activity-appended'
        AND json_extract(events.payload_json, '$.activity.kind') LIKE 'task.%'
        AND nullif(
          trim(json_extract(events.payload_json, '$.activity.payload.taskId')),
          ''
        ) IS NOT NULL
    ),
    seed_candidates AS MATERIALIZED (
      SELECT
        task_events.*,
        CASE
          WHEN normalized_task_type = 'codex_cli'
            OR agent_run_id LIKE 'codex-cli:%'
          THEN 'codex'
          ELSE 'claude'
        END AS provider
      FROM task_events
      WHERE normalized_task_type <> 'local_bash'
        AND (
          normalized_task_type IN ('codex_cli', 'agent')
          OR normalized_task_type LIKE '%_agent'
          OR agent_type IS NOT NULL
          OR history_session_id IS NOT NULL
          OR agent_run_id LIKE 'codex-cli:%'
        )
    ),
    agent_seeds AS MATERIALIZED (
      SELECT DISTINCT
        parent_thread_id,
        provider,
        agent_run_id
      FROM seed_candidates
    ),
    seed_counts AS MATERIALIZED (
      SELECT
        parent_thread_id,
        agent_run_id,
        count(*) AS provider_count
      FROM agent_seeds
      GROUP BY parent_thread_id, agent_run_id
    ),
    matched_events AS MATERIALIZED (
      SELECT
        seeds.parent_thread_id,
        seeds.provider,
        seeds.agent_run_id,
        events.sequence,
        events.activity_kind,
        events.created_at,
        events.task_type,
        events.launch_tool_use_id,
        events.agent_type,
        events.model,
        events.description,
        events.history_session_id,
        events.parent_native_session_id,
        CASE
          WHEN events.activity_kind = 'task.completed' THEN
            CASE
              WHEN events.lifecycle_status = 'failed' THEN 'failed'
              WHEN events.lifecycle_status = 'stopped' THEN 'stopped'
              ELSE 'completed'
            END
          WHEN events.activity_kind = 'task.updated' THEN
            CASE
              WHEN events.lifecycle_status IN ('completed', 'failed', 'paused', 'running')
                THEN events.lifecycle_status
              WHEN events.lifecycle_status IN ('killed', 'stopped') THEN 'stopped'
              ELSE NULL
            END
          WHEN events.activity_kind IN ('task.started', 'task.progress') THEN 'running'
          ELSE NULL
        END AS projected_status
      FROM agent_seeds AS seeds
      INNER JOIN seed_counts AS counts
        ON counts.parent_thread_id = seeds.parent_thread_id
        AND counts.agent_run_id = seeds.agent_run_id
      INNER JOIN task_events AS events
        ON events.parent_thread_id = seeds.parent_thread_id
        AND events.agent_run_id = seeds.agent_run_id
      WHERE
        CASE
          WHEN events.normalized_task_type = 'codex_cli'
            OR events.agent_run_id LIKE 'codex-cli:%'
          THEN 'codex'
          WHEN events.normalized_task_type = 'local_bash' THEN 'background'
          WHEN events.normalized_task_type = 'agent'
            OR events.normalized_task_type LIKE '%_agent'
            OR events.agent_type IS NOT NULL
            OR events.history_session_id IS NOT NULL
          THEN 'claude'
          ELSE NULL
        END = seeds.provider
        OR (
          events.normalized_task_type = ''
          AND events.agent_type IS NULL
          AND events.history_session_id IS NULL
          AND counts.provider_count = 1
        )
    ),
    status_ranked AS MATERIALIZED (
      SELECT
        matched_events.*,
        row_number() OVER (
          PARTITION BY parent_thread_id, provider, agent_run_id
          ORDER BY
            CASE
              WHEN projected_status IN ('completed', 'failed', 'stopped') THEN 1
              ELSE 0
            END DESC,
            CASE
              WHEN projected_status IN ('completed', 'failed', 'stopped') THEN sequence
              ELSE NULL
            END ASC,
            CASE
              WHEN projected_status NOT IN ('completed', 'failed', 'stopped') THEN sequence
              ELSE NULL
            END DESC
        ) AS status_rank
      FROM matched_events
      WHERE projected_status IS NOT NULL
    ),
    folded AS MATERIALIZED (
      SELECT
        seeds.parent_thread_id,
        seeds.provider,
        seeds.agent_run_id,
        (
          SELECT launch_tool_use_id
          FROM matched_events AS value
          WHERE value.parent_thread_id = seeds.parent_thread_id
            AND value.provider = seeds.provider
            AND value.agent_run_id = seeds.agent_run_id
            AND value.launch_tool_use_id IS NOT NULL
          ORDER BY value.sequence DESC
          LIMIT 1
        ) AS launch_tool_use_id,
        (
          SELECT task_type
          FROM matched_events AS value
          WHERE value.parent_thread_id = seeds.parent_thread_id
            AND value.provider = seeds.provider
            AND value.agent_run_id = seeds.agent_run_id
            AND value.task_type IS NOT NULL
          ORDER BY value.sequence DESC
          LIMIT 1
        ) AS task_type,
        (
          SELECT agent_type
          FROM matched_events AS value
          WHERE value.parent_thread_id = seeds.parent_thread_id
            AND value.provider = seeds.provider
            AND value.agent_run_id = seeds.agent_run_id
            AND value.agent_type IS NOT NULL
          ORDER BY value.sequence DESC
          LIMIT 1
        ) AS agent_type,
        (
          SELECT model
          FROM matched_events AS value
          WHERE value.parent_thread_id = seeds.parent_thread_id
            AND value.provider = seeds.provider
            AND value.agent_run_id = seeds.agent_run_id
            AND value.model IS NOT NULL
          ORDER BY value.sequence DESC
          LIMIT 1
        ) AS model,
        (
          SELECT description
          FROM matched_events AS value
          WHERE value.parent_thread_id = seeds.parent_thread_id
            AND value.provider = seeds.provider
            AND value.agent_run_id = seeds.agent_run_id
            AND value.description IS NOT NULL
          ORDER BY value.sequence DESC
          LIMIT 1
        ) AS description,
        coalesce(
          (
            SELECT projected_status
            FROM status_ranked AS status
            WHERE status.parent_thread_id = seeds.parent_thread_id
              AND status.provider = seeds.provider
              AND status.agent_run_id = seeds.agent_run_id
              AND status.status_rank = 1
          ),
          'running'
        ) AS status,
        min(events.created_at) AS started_at,
        max(events.created_at) AS updated_at,
        (
          SELECT history_session_id
          FROM matched_events AS value
          WHERE value.parent_thread_id = seeds.parent_thread_id
            AND value.provider = seeds.provider
            AND value.agent_run_id = seeds.agent_run_id
            AND value.history_session_id IS NOT NULL
          ORDER BY value.sequence DESC
          LIMIT 1
        ) AS history_session_id,
        (
          SELECT parent_native_session_id
          FROM matched_events AS value
          WHERE value.parent_thread_id = seeds.parent_thread_id
            AND value.provider = seeds.provider
            AND value.agent_run_id = seeds.agent_run_id
            AND value.parent_native_session_id IS NOT NULL
          ORDER BY value.sequence DESC
          LIMIT 1
        ) AS parent_native_session_id
      FROM agent_seeds AS seeds
      INNER JOIN matched_events AS events
        ON events.parent_thread_id = seeds.parent_thread_id
        AND events.provider = seeds.provider
        AND events.agent_run_id = seeds.agent_run_id
      GROUP BY seeds.parent_thread_id, seeds.provider, seeds.agent_run_id
    ),
    history_ranked AS (
      SELECT
        folded.*,
        CASE
          WHEN history_session_id IS NULL THEN NULL
          ELSE row_number() OVER (
            PARTITION BY history_session_id
            ORDER BY started_at, parent_thread_id, provider, agent_run_id
          )
        END AS history_owner_rank
      FROM folded
    )
    INSERT INTO projection_agent_runs (
      parent_thread_id,
      provider,
      agent_run_id,
      launch_tool_use_id,
      task_type,
      agent_type,
      model,
      description,
      status,
      started_at,
      updated_at,
      history_session_id,
      transcript_state,
      parent_native_session_id
    )
    SELECT
      parent_thread_id,
      provider,
      agent_run_id,
      launch_tool_use_id,
      task_type,
      agent_type,
      model,
      description,
      status,
      started_at,
      updated_at,
      CASE WHEN history_owner_rank = 1 THEN history_session_id ELSE NULL END,
      CASE
        WHEN history_owner_rank = 1 THEN 'linked'
        WHEN status IN ('completed', 'failed', 'stopped') THEN 'unavailable'
        ELSE 'pending'
      END,
      parent_native_session_id
    FROM history_ranked
  `;

  yield* sql`
    INSERT INTO projection_state (
      projector,
      last_applied_sequence,
      updated_at
    )
    SELECT
      'projection.agent-runs',
      coalesce(max(sequence), 0),
      coalesce(max(occurred_at), '1970-01-01T00:00:00.000Z')
    FROM orchestration_events
    WHERE true
    ON CONFLICT(projector) DO UPDATE SET
      last_applied_sequence = excluded.last_applied_sequence,
      updated_at = excluded.updated_at
  `;

  // The runtime resume cursor is the one historical mapping Starcode still
  // retains reliably. Older sessions not represented here remain unavailable;
  // they are never inferred from cwd or project alone.
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_native_sessions (
      thread_id,
      provider,
      native_session_id,
      observed_at
    )
    SELECT
      thread_id,
      'claude',
      json_extract(resume_cursor_json, '$.resume'),
      last_seen_at
    FROM provider_session_runtime
    WHERE provider_name = 'claudeAgent'
      AND json_extract(resume_cursor_json, '$.resume') IS NOT NULL
  `;
});
