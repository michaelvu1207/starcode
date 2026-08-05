import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderOptionSelections } from "@starcode/contracts";

const encodeOptions = Schema.encodeSync(Schema.fromJsonString(ProviderOptionSelections));

/** Preserve exact provider launch options on the durable AgentRun read model. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_agent_runs
    ADD COLUMN model_options_json TEXT
  `;

  // Runs created before this column encoded Pi effort in the display label.
  // Recover only the six values Pi actually accepts; all other legacy rows
  // remain unknown rather than inventing provider options.
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
    yield* sql`
      UPDATE projection_agent_runs
      SET model_options_json = ${encodeOptions([{ id: "effort", value: effort }])}
      WHERE provider = 'pi'
        AND lower(agent_type) LIKE ${`% · ${effort} effort`}
        AND model_options_json IS NULL
    `;
  }
});
