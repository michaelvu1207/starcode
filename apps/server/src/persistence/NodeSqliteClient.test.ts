// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off - cross-process SQLite locking needs native process/filesystem fixtures and wall-clock elapsed time.
import { assert, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );
});

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect("waits through a transient write lock held by another Starcode process", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "starcode-sqlite-lock-"))),
    (directory) =>
      Effect.gen(function* () {
        const filename = join(directory, "state.sqlite");
        const holder = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE entries(value TEXT); BEGIN IMMEDIATE; INSERT INTO entries VALUES ('holder')");
process.stdout.write("locked\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 150);`,
            filename,
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );

        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              holder.once("error", reject);
              holder.stdout.once("data", () => resolve());
            }),
        );

        const startedAt = Date.now();
        const rows = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO entries(value) VALUES (${"starcode"})`;
          return yield* sql<{ readonly value: string }>`SELECT value FROM entries ORDER BY rowid`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped);

        assert.isAtLeast(Date.now() - startedAt, 75);
        assert.deepEqual(
          rows.map((row) => row.value),
          ["holder", "starcode"],
        );
      }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ),
);
