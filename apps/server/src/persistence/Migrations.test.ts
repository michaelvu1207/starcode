import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("runMigrations on a fresh database", (it) => {
  it.effect("records every migration entry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const applied = yield* sql<{
        readonly migration_id: number;
      }>`SELECT migration_id FROM effect_sql_migrations`;
      assert.deepEqual(
        applied.map((row) => row.migration_id).sort((left, right) => left - right),
        migrationEntries.map(([id]) => id),
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("runMigrations completeness assertion", (it) => {
  it.effect("fails when the migrator passes over an entry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // The Migrator only runs ids above the highest applied id, so an entry
      // left below that watermark is skipped without a word on every later
      // run - exactly what a renumbering or an id reused across a merge does.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 20`;
      const error = yield* runMigrations().pipe(Effect.flip);
      assert.include(error.message, "20_AuthAccessManagement");
    }),
  );
});
