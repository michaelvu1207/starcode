import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist heterogeneous provider selection and nesting for same-task AgentRuns. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_agent_runs)
  `;
  if (!columns.some((column) => column.name === "provider_instance_id")) {
    yield* sql`
      ALTER TABLE projection_agent_runs
      ADD COLUMN provider_instance_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "parent_agent_run_id")) {
    yield* sql`
      ALTER TABLE projection_agent_runs
      ADD COLUMN parent_agent_run_id TEXT
    `;
  }
});
