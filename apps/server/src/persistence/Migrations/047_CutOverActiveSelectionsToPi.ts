import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Move only current launch selections onto Pi.
 *
 * Historical orchestration events and provider bindings are provenance: they
 * continue to say which removed runtime produced the old conversation and
 * retain their native cursor/payload. Rewriting those values to Pi would make
 * a Claude/Codex cursor look runnable by Pi. Current project/thread projection
 * selectors, by contrast, decide what a new turn launches and must no longer
 * point at a removed instance.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_set(
      default_model_selection_json,
      '$.instanceId',
      'pi',
      '$.model',
      CASE
        WHEN instr(json_extract(default_model_selection_json, '$.model'), '/') > 0
          THEN json_extract(default_model_selection_json, '$.model')
        WHEN lower(json_extract(default_model_selection_json, '$.instanceId')) LIKE 'claude%'
          OR EXISTS (
            SELECT 1
            FROM provider_session_runtime runtime
            WHERE runtime.provider_instance_id = json_extract(
              default_model_selection_json,
              '$.instanceId'
            )
              AND runtime.provider_name = 'claudeAgent'
          )
          THEN 'anthropic/' || json_extract(default_model_selection_json, '$.model')
        ELSE 'openai-codex/' || json_extract(default_model_selection_json, '$.model')
      END
    )
    WHERE json_type(default_model_selection_json) = 'object'
      AND json_type(default_model_selection_json, '$.model') = 'text'
      AND (
        lower(json_extract(default_model_selection_json, '$.instanceId')) LIKE 'codex%'
        OR lower(json_extract(default_model_selection_json, '$.instanceId')) LIKE 'claude%'
        OR EXISTS (
          SELECT 1
          FROM provider_session_runtime runtime
          WHERE runtime.provider_instance_id = json_extract(
            default_model_selection_json,
            '$.instanceId'
          )
            AND runtime.provider_name IN ('codex', 'claudeAgent')
        )
      )
  `;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_set(
      model_selection_json,
      '$.instanceId',
      'pi',
      '$.model',
      CASE
        WHEN instr(json_extract(model_selection_json, '$.model'), '/') > 0
          THEN json_extract(model_selection_json, '$.model')
        WHEN lower(json_extract(model_selection_json, '$.instanceId')) LIKE 'claude%'
          OR EXISTS (
            SELECT 1
            FROM provider_session_runtime runtime
            WHERE runtime.thread_id = projection_threads.thread_id
              AND runtime.provider_instance_id = json_extract(
                model_selection_json,
                '$.instanceId'
              )
              AND runtime.provider_name = 'claudeAgent'
          )
          THEN 'anthropic/' || json_extract(model_selection_json, '$.model')
        ELSE 'openai-codex/' || json_extract(model_selection_json, '$.model')
      END
    )
    WHERE json_type(model_selection_json) = 'object'
      AND json_type(model_selection_json, '$.model') = 'text'
      AND NOT EXISTS (
        SELECT 1
        FROM provider_session_runtime bound_runtime
        WHERE bound_runtime.thread_id = projection_threads.thread_id
          AND bound_runtime.provider_name != 'pi'
      )
      AND (
        lower(json_extract(model_selection_json, '$.instanceId')) LIKE 'codex%'
        OR lower(json_extract(model_selection_json, '$.instanceId')) LIKE 'claude%'
        OR EXISTS (
          SELECT 1
          FROM provider_session_runtime runtime
          WHERE runtime.thread_id = projection_threads.thread_id
            AND runtime.provider_instance_id = json_extract(
              model_selection_json,
              '$.instanceId'
            )
            AND runtime.provider_name IN ('codex', 'claudeAgent')
        )
      )
  `;

  // Translate only option names/values whose Pi spelling differs. Unknown
  // options remain byte-for-byte values in the array for rollback tolerance.
  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_set(
      default_model_selection_json,
      '$.options',
      (
        SELECT json_group_array(
          json_object(
            'id', CASE value ->> '$.id'
              WHEN 'reasoningEffort' THEN 'effort'
              WHEN 'contextWindow' THEN 'context'
              ELSE value ->> '$.id'
            END,
            'value', CASE
              WHEN (value ->> '$.id') IN ('reasoningEffort', 'effort')
                AND (value ->> '$.value') = 'max'
                THEN 'xhigh'
              ELSE value ->> '$.value'
            END
          )
        )
        FROM json_each(json_extract(default_model_selection_json, '$.options'))
      )
    )
    WHERE json_extract(default_model_selection_json, '$.instanceId') = 'pi'
      AND json_type(default_model_selection_json, '$.options') = 'array'
  `;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_set(
      model_selection_json,
      '$.options',
      (
        SELECT json_group_array(
          json_object(
            'id', CASE value ->> '$.id'
              WHEN 'reasoningEffort' THEN 'effort'
              WHEN 'contextWindow' THEN 'context'
              ELSE value ->> '$.id'
            END,
            'value', CASE
              WHEN (value ->> '$.id') IN ('reasoningEffort', 'effort')
                AND (value ->> '$.value') = 'max'
                THEN 'xhigh'
              ELSE value ->> '$.value'
            END
          )
        )
        FROM json_each(json_extract(model_selection_json, '$.options'))
      )
    )
    WHERE json_extract(model_selection_json, '$.instanceId') = 'pi'
      AND json_type(model_selection_json, '$.options') = 'array'
  `;

  // Retire executable lifecycle state without changing provider/cursor/payload
  // attribution. Startup recovery applies the same policy defensively.
  yield* sql`
    UPDATE provider_session_runtime
    SET status = 'stopped'
    WHERE provider_name != 'pi'
      AND status IN ('starting', 'running')
  `;
});
