/**
 * Fork migration: per-provider-instance usage.
 *
 * `fork_usage_turns` is one row per completed turn, keyed by the runtime event
 * id so a replayed or duplicated event cannot double-count spend. Raw rows
 * rather than pre-aggregated day buckets, because the day boundary depends on
 * the reader's time zone and the volume is a few hundred rows a day.
 *
 * `fork_usage_rate_limits` is latest-wins, one row per instance: rate limits
 * are current state, not history.
 *
 * Written idempotently on purpose — fork migrations get renumbered above
 * upstream's on every merge and therefore re-run. See NOTES-mapper-addendum
 * section 7.4.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_usage_turns (
      event_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      completed_at TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0
    )
  `;

  // The only read is "every turn since <instant>, grouped by instance", so one
  // index on the range column carries it.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_usage_turns_completed_at
    ON fork_usage_turns (completed_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_usage_rate_limits (
      provider_instance_id TEXT PRIMARY KEY,
      driver TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    )
  `;
});
