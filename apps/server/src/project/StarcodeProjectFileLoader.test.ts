import * as NodeServices from "@effect/platform-node/NodeServices";
import { LEGACY_PROJECT_FILE_NAME, STARCODE_PROJECT_FILE_NAME } from "@starcode/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as StarcodeProjectFileLoader from "./StarcodeProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(StarcodeProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "starcode-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (
  cwd: string,
  fileName: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, fileName), contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("StarcodeProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("prefers and decodes a valid starcode.json", () =>
      Effect.gen(function* () {
        const loader = yield* StarcodeProjectFileLoader.StarcodeProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          STARCODE_PROJECT_FILE_NAME,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("loads t3.json when starcode.json is absent", () =>
      Effect.gen(function* () {
        const loader = yield* StarcodeProjectFileLoader.StarcodeProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          LEGACY_PROJECT_FILE_NAME,
          '{ "iconPath": "assets/legacy.svg" }',
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/legacy.svg");
        }
      }),
    );

    it.effect("uses starcode.json without merging when both names are present", () =>
      Effect.gen(function* () {
        const loader = yield* StarcodeProjectFileLoader.StarcodeProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          STARCODE_PROJECT_FILE_NAME,
          '{ "iconPath": "assets/new.svg" }',
        );
        yield* writeProjectFile(
          cwd,
          LEGACY_PROJECT_FILE_NAME,
          '{ "iconPath": "assets/legacy.svg", "scripts": [{ "name": "Legacy", "command": "legacy" }] }',
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value).toEqual({ iconPath: "assets/new.svg" });
        }
      }),
    );

    it.effect("returns none when neither project filename exists", () =>
      Effect.gen(function* () {
        const loader = yield* StarcodeProjectFileLoader.StarcodeProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* StarcodeProjectFileLoader.StarcodeProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, STARCODE_PROJECT_FILE_NAME, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* StarcodeProjectFileLoader.StarcodeProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          STARCODE_PROJECT_FILE_NAME,
          '{ "scripts": [{ "name": "Dev" }] }',
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
