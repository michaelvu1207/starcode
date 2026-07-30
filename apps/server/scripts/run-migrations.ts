/**
 * Applies the server's migrations to a database, out of band.
 *
 * The server runs migrations itself at boot, which is how they normally land.
 * This exists for the case where a database has to be brought forward without
 * starting the process that owns it — an idle profile, a backup, a machine
 * whose app is not running. It reuses `runMigrations` rather than restating
 * anything, so "migrated by this script" and "migrated at boot" cannot drift.
 *
 * Usage: node apps/server/scripts/run-migrations.ts <path-to-state.sqlite> [...]
 *
 * Lives under apps/server rather than the root scripts/ project so that the
 * relative imports below stay inside one TypeScript project — the root project
 * does not list apps/server sources, and reaching across is a TS6307 error.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

const migrate = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql<{
      readonly applied: number;
    }>`SELECT COALESCE(MAX(migration_id), 0) AS applied FROM effect_sql_migrations`.pipe(
      Effect.catchCause(() => Effect.succeed([{ applied: 0 }])),
    );
    yield* runMigrations();
    const after = yield* sql<{
      readonly applied: number;
    }>`SELECT COALESCE(MAX(migration_id), 0) AS applied FROM effect_sql_migrations`;
    yield* Console.log(`${filename}: ${before[0]?.applied ?? 0} -> ${after[0]?.applied ?? 0}`);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

const paths = process.argv.slice(2);
if (paths.length === 0) {
  process.stderr.write(
    "usage: node apps/server/scripts/run-migrations.ts <path-to-state.sqlite> [...]\n",
  );
  process.exit(1);
}

await Effect.runPromise(
  Effect.forEach(paths, migrate, { discard: true }).pipe(Effect.provide(Layer.empty)),
);
