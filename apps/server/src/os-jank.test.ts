import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { migrateLegacyServerHome, resolveBaseDir } from "./os-jank.ts";

it.layer(NodeServices.layer)("server home", (it) => {
  it.effect("defaults to ~/.starcode", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(yield* resolveBaseDir(undefined), path.join(NodeOS.homedir(), ".starcode"));
    }),
  );

  it.effect("copies the complete legacy tree and keeps ~/.t3 as rollback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "starcode-home-migration-" });
      const legacyHome = path.join(home, ".t3");
      const starcodeHome = path.join(home, ".starcode");
      const legacyStateDir = path.join(legacyHome, "userdata");
      yield* fs.makeDirectory(path.join(legacyStateDir, "nested"), { recursive: true });
      yield* Effect.all([
        fs.writeFileString(path.join(legacyStateDir, "state.sqlite"), "database"),
        fs.writeFileString(path.join(legacyStateDir, "state.sqlite-wal"), "wal"),
        fs.writeFileString(path.join(legacyStateDir, "state.sqlite-shm"), "shm"),
        fs.writeFileString(path.join(legacyStateDir, "nested", "settings.json"), "settings"),
      ]);

      yield* migrateLegacyServerHome(starcodeHome, home);

      assert.equal(
        yield* fs.readFileString(path.join(starcodeHome, "userdata", "state.sqlite")),
        "database",
      );
      assert.equal(
        yield* fs.readFileString(path.join(starcodeHome, "userdata", "state.sqlite-wal")),
        "wal",
      );
      assert.equal(
        yield* fs.readFileString(path.join(starcodeHome, "userdata", "state.sqlite-shm")),
        "shm",
      );
      assert.equal(
        yield* fs.readFileString(path.join(starcodeHome, "userdata", "nested", "settings.json")),
        "settings",
      );
      assert.equal(yield* fs.readFileString(path.join(legacyStateDir, "state.sqlite")), "database");
      assert.deepStrictEqual(
        (yield* fs.readDirectory(home)).filter((entry) => entry.startsWith(".starcode-migration-")),
        [],
      );
    }),
  );

  it.effect("does not merge legacy state into an existing or custom home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "starcode-home-existing-" });
      const legacyHome = path.join(home, ".t3");
      const starcodeHome = path.join(home, ".starcode");
      const customHome = path.join(home, "custom");
      yield* fs.makeDirectory(legacyHome, { recursive: true });
      yield* fs.writeFileString(path.join(legacyHome, "legacy.txt"), "legacy");
      yield* fs.makeDirectory(starcodeHome, { recursive: true });
      yield* fs.writeFileString(path.join(starcodeHome, "current.txt"), "current");

      yield* migrateLegacyServerHome(starcodeHome, home);
      yield* migrateLegacyServerHome(customHome, home);

      assert.isFalse(yield* fs.exists(path.join(starcodeHome, "legacy.txt")));
      assert.equal(yield* fs.readFileString(path.join(starcodeHome, "current.txt")), "current");
      assert.isFalse(yield* fs.exists(customHome));
    }),
  );
});
