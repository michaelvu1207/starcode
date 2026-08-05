import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/starcode.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/starcode.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

type TestEnvironmentInput = Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> & {
  readonly env?: Record<string, string | undefined>;
};

interface ElectronAppCalls {
  readonly setAboutPanelOptions: Array<Electron.AboutPanelOptionsOptions>;
  readonly setDockIcon: string[];
  readonly setName: string[];
}

const makeElectronAppLayer = (calls: ElectronAppCalls) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("starcode"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: (name) =>
      Effect.sync(() => {
        calls.setName.push(name);
      }),
    setAboutPanelOptions: (options) =>
      Effect.sync(() => {
        calls.setAboutPanelOptions.push(options);
      }),
    setAppUserModelId: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: (iconPath) =>
      Effect.sync(() => {
        calls.setDockIcon.push(iconPath);
      }),
    appendCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const makeAssetsLayer = (png: Option.Option<string>) =>
  Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png,
    }),
    resolveResourcePath: () => Effect.succeed(Option.none()),
  } satisfies DesktopAssets.DesktopAssets["Service"]);

const makeEnvironmentLayer = (overrides: TestEnvironmentInput = {}) => {
  const { env, ...environmentOverrides } = overrides;
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...environmentOverrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          ...env,
        }),
      ),
    ),
  );
};

const withIdentity = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopAppIdentity.DesktopAppIdentity
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  input: {
    readonly calls?: ElectronAppCalls;
    readonly copyError?: PlatformError.PlatformError;
    readonly copyCalls?: Array<readonly [sourcePath: string, destinationPath: string]>;
    readonly environment?: TestEnvironmentInput;
    readonly existingPaths?: readonly string[];
    readonly packageJson?: string;
    readonly pathProbeError?: {
      readonly path: string;
      readonly cause: PlatformError.PlatformError;
    };
    readonly pngIconPath?: Option.Option<string>;
  } = {},
) => {
  const calls: ElectronAppCalls = input.calls ?? {
    setAboutPanelOptions: [],
    setDockIcon: [],
    setName: [],
  };

  return effect.pipe(
    Effect.provide(
      DesktopAppIdentity.layer.pipe(
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (path) =>
              input.pathProbeError?.path === path
                ? Effect.fail(input.pathProbeError.cause)
                : Effect.succeed(input.existingPaths?.includes(path) === true),
            copy: (sourcePath, destinationPath) =>
              input.copyError
                ? Effect.fail(input.copyError)
                : Effect.sync(() => {
                    input.copyCalls?.push([sourcePath, destinationPath]);
                  }),
            readFileString: () =>
              Effect.succeed(input.packageJson ?? '{"starcodeCommitHash":"abcdef1234567890"}'),
          }),
        ),
        Layer.provideMerge(makeAssetsLayer(input.pngIconPath ?? Option.none())),
        Layer.provideMerge(makeElectronAppLayer(calls)),
        Layer.provideMerge(makeEnvironmentLayer(input.environment)),
      ),
    ),
  );
};

describe("DesktopAppIdentity", () => {
  it.effect("prefers the new userData path without copying legacy data", () => {
    const copyCalls: Array<readonly [string, string]> = [];
    const userDataPath = "/Users/alice/Library/Application Support/starcode";

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const resolvedPath = yield* identity.resolveUserDataPath;

        assert.equal(resolvedPath, userDataPath);
        assert.deepEqual(copyCalls, []);
      }),
      {
        copyCalls,
        existingPaths: [
          userDataPath,
          "/Users/alice/Library/Application Support/starcode",
          "/Users/alice/Library/Application Support/T3 Code (Alpha)",
        ],
      },
    );
  });

  it.effect("copies legacy userData into the new path when the new path is absent", () => {
    const copyCalls: Array<readonly [string, string]> = [];
    const legacyPath = "/Users/alice/Library/Application Support/T3 Code (Alpha)";
    const userDataPath = "/Users/alice/Library/Application Support/starcode";

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const resolvedPath = yield* identity.resolveUserDataPath;

        assert.equal(resolvedPath, userDataPath);
        assert.deepEqual(copyCalls, [[legacyPath, userDataPath]]);
      }),
      { copyCalls, existingPaths: [legacyPath] },
    );
  });

  it.effect("copies the newest legacy userData path when multiple legacy paths exist", () => {
    const copyCalls: Array<readonly [string, string]> = [];
    const newerLegacyPath = "/Users/alice/Library/Application Support/t3code";
    const olderLegacyPath = "/Users/alice/Library/Application Support/T3 Code (Alpha)";
    const userDataPath = "/Users/alice/Library/Application Support/starcode";

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const resolvedPath = yield* identity.resolveUserDataPath;

        assert.equal(resolvedPath, userDataPath);
        assert.deepEqual(copyCalls, [[newerLegacyPath, userDataPath]]);
      }),
      { copyCalls, existingPaths: [newerLegacyPath, olderLegacyPath] },
    );
  });

  it.effect("uses the new userData path without copying when no legacy path exists", () => {
    const copyCalls: Array<readonly [string, string]> = [];
    const userDataPath = "/Users/alice/Library/Application Support/starcode";

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const resolvedPath = yield* identity.resolveUserDataPath;

        assert.equal(resolvedPath, userDataPath);
        assert.deepEqual(copyCalls, []);
      }),
      { copyCalls },
    );
  });

  it.effect("preserves failures while inspecting the legacy userData path", () => {
    const legacyPath = "/Users/alice/Library/Application Support/t3code";
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      description: "permission denied",
      pathOrDescriptor: legacyPath,
    });

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const error = yield* identity.resolveUserDataPath.pipe(Effect.flip);

        assert.instanceOf(error, DesktopAppIdentity.DesktopUserDataPathResolutionError);
        assert.equal(error.legacyPath, legacyPath);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          `Failed to inspect legacy desktop user-data path at "${legacyPath}".`,
        );
      }),
      { pathProbeError: { path: legacyPath, cause } },
    );
  });

  it.effect("preserves failures while copying legacy userData", () => {
    const legacyPath = "/Users/alice/Library/Application Support/t3code";
    const userDataPath = "/Users/alice/Library/Application Support/starcode";
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "copy",
      description: "permission denied",
      pathOrDescriptor: legacyPath,
    });

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        const error = yield* identity.resolveUserDataPath.pipe(Effect.flip);

        assert.instanceOf(error, DesktopAppIdentity.DesktopUserDataPathResolutionError);
        assert.equal(error.legacyPath, legacyPath);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          `Failed to inspect legacy desktop user-data path at "${legacyPath}".`,
        );
        assert.notEqual(error.legacyPath, userDataPath);
      }),
      { copyError: cause, existingPaths: [legacyPath] },
    );
  });

  it.effect("configures app identity from the environment commit override", () => {
    const calls: ElectronAppCalls = {
      setAboutPanelOptions: [],
      setDockIcon: [],
      setName: [],
    };

    return withIdentity(
      Effect.gen(function* () {
        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
        yield* identity.configure;

        assert.deepEqual(calls.setName, ["starcode"]);
        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "starcode");
        assert.equal(calls.setAboutPanelOptions[0]?.applicationVersion, "1.2.3");
        assert.equal(calls.setAboutPanelOptions[0]?.version, "0123456789ab");
        assert.deepEqual(calls.setDockIcon, ["/icon.png"]);
      }),
      {
        calls,
        environment: {
          env: {
            STARCODE_COMMIT_HASH: "0123456789abcdef",
          },
        },
        pngIconPath: Option.some("/icon.png"),
      },
    );
  });
});
