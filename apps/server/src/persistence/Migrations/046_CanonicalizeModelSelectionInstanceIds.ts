import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Canonicalize rollout-era model selections onto the configured-instance
 * routing key. `accountId` was written by the Pi baseline, while `provider`
 * was the preceding generic shape. Prefer an already-canonical `instanceId`,
 * preserve model/options, and remove both obsolete routing aliases.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_remove(
      json_set(
        default_model_selection_json,
        '$.instanceId',
        coalesce(
          json_extract(default_model_selection_json, '$.instanceId'),
          json_extract(default_model_selection_json, '$.accountId'),
          json_extract(default_model_selection_json, '$.provider')
        )
      ),
      '$.accountId',
      '$.provider'
    )
    WHERE json_type(default_model_selection_json) = 'object'
      AND (
        json_type(default_model_selection_json, '$.accountId') = 'text'
        OR json_type(default_model_selection_json, '$.provider') = 'text'
      )
  `;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_remove(
      json_set(
        model_selection_json,
        '$.instanceId',
        coalesce(
          json_extract(model_selection_json, '$.instanceId'),
          json_extract(model_selection_json, '$.accountId'),
          json_extract(model_selection_json, '$.provider')
        )
      ),
      '$.accountId',
      '$.provider'
    )
    WHERE json_type(model_selection_json) = 'object'
      AND (
        json_type(model_selection_json, '$.accountId') = 'text'
        OR json_type(model_selection_json, '$.provider') = 'text'
      )
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.modelSelection.instanceId',
        coalesce(
          json_extract(payload_json, '$.modelSelection.instanceId'),
          json_extract(payload_json, '$.modelSelection.accountId'),
          json_extract(payload_json, '$.modelSelection.provider')
        )
      ),
      '$.modelSelection.accountId',
      '$.modelSelection.provider'
    )
    WHERE json_type(payload_json, '$.modelSelection') = 'object'
      AND (
        json_type(payload_json, '$.modelSelection.accountId') = 'text'
        OR json_type(payload_json, '$.modelSelection.provider') = 'text'
      )
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.defaultModelSelection.instanceId',
        coalesce(
          json_extract(payload_json, '$.defaultModelSelection.instanceId'),
          json_extract(payload_json, '$.defaultModelSelection.accountId'),
          json_extract(payload_json, '$.defaultModelSelection.provider')
        )
      ),
      '$.defaultModelSelection.accountId',
      '$.defaultModelSelection.provider'
    )
    WHERE json_type(payload_json, '$.defaultModelSelection') = 'object'
      AND (
        json_type(payload_json, '$.defaultModelSelection.accountId') = 'text'
        OR json_type(payload_json, '$.defaultModelSelection.provider') = 'text'
      )
  `;
});
