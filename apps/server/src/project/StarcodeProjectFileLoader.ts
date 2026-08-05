/**
 * StarcodeProjectFileLoader - Effect service that loads the checked-in
 * `starcode.json` project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module StarcodeProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  LEGACY_PROJECT_FILE_NAME,
  STARCODE_PROJECT_FILE_NAME,
  type StarcodeProjectFile,
} from "@starcode/contracts";
import { StarcodeProjectFileFromJson } from "@starcode/shared/starcodeProjectFile";

const decodeStarcodeProjectFileJson = Schema.decodeEffect(StarcodeProjectFileFromJson);

export class StarcodeProjectFileLoadError extends Schema.TaggedErrorClass<StarcodeProjectFileLoadError>()(
  "StarcodeProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} project file at ${this.filePath}.`;
  }
}

/** Service tag for starcode project file loading. */
export class StarcodeProjectFileLoader extends Context.Service<
  StarcodeProjectFileLoader,
  {
    /**
     * Load and decode the project file at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<StarcodeProjectFile>>;
  }
>()("starcode/project/StarcodeProjectFileLoader") {}

const logStarcodeProjectFileLoadError = (error: StarcodeProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  type ProjectFileRead =
    | { readonly _tag: "Found"; readonly filePath: string; readonly contents: string }
    | { readonly _tag: "Missing" }
    | { readonly _tag: "Failed" };

  const readProjectFile = Effect.fn("StarcodeProjectFileLoader.readProjectFile")(function* (
    workspaceRoot: string,
    fileName: string,
  ): Effect.fn.Return<ProjectFileRead> {
    const filePath = path.join(workspaceRoot, fileName);
    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(
        (contents): ProjectFileRead => ({
          _tag: "Found",
          filePath,
          contents,
        }),
      ),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<ProjectFileRead>({ _tag: "Missing" })
            : logStarcodeProjectFileLoadError(
                new StarcodeProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as<ProjectFileRead>({ _tag: "Failed" })),
      }),
    );
  });

  const load: StarcodeProjectFileLoader["Service"]["load"] = Effect.fn(
    "StarcodeProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const preferred = yield* readProjectFile(workspaceRoot, STARCODE_PROJECT_FILE_NAME);
    // Users have t3.json committed in existing repositories, so the legacy
    // name remains readable only when the replacement file is truly absent.
    // A present new file stays authoritative even when it cannot be decoded.
    const selected =
      preferred._tag === "Missing"
        ? yield* readProjectFile(workspaceRoot, LEGACY_PROJECT_FILE_NAME)
        : preferred;
    if (selected._tag !== "Found") {
      return Option.none<StarcodeProjectFile>();
    }
    return yield* decodeStarcodeProjectFileJson(selected.contents).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SchemaError: (error) =>
          logStarcodeProjectFileLoadError(
            new StarcodeProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath: selected.filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<StarcodeProjectFile>())),
      }),
    );
  });

  return StarcodeProjectFileLoader.of({ load });
});

export const layer = Layer.effect(StarcodeProjectFileLoader, make);
