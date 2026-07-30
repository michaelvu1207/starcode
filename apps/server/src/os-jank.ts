import { HostProcessEnvironment, HostProcessPlatform } from "@starcode/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
} from "@starcode/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = readPathFromLoginShell(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (): Effect.fn.Return<
  void,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".starcode");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});

export const migrateLegacyServerHome = Effect.fn("migrateLegacyServerHome")(function* (
  baseDir: string,
  homeDirectory = NodeOS.homedir(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacyHome = path.join(homeDirectory, ".t3");
  const starcodeHome = path.join(homeDirectory, ".starcode");

  if (
    path.resolve(baseDir) !== path.resolve(starcodeHome) ||
    (yield* fs.exists(starcodeHome)) ||
    !(yield* fs.exists(legacyHome))
  ) {
    return;
  }

  // Copy into a sibling staging directory so every legacy file—including SQLite's database,
  // WAL, and shared-memory siblings—lands in one pre-startup operation. Publishing only after
  // the recursive copy succeeds prevents a failed first run from making a partial destination
  // look migrated, while retaining ~/.t3 verbatim keeps the rollback path available.
  const stagingHome = yield* fs.makeTempDirectory({
    directory: homeDirectory,
    prefix: ".starcode-migration-",
  });
  yield* fs.copy(legacyHome, stagingHome, { preserveTimestamps: true }).pipe(
    Effect.flatMap(() =>
      fs.rename(stagingHome, starcodeHome).pipe(
        // Concurrent first-use processes may both finish copying; whichever publishes first
        // wins, and the loser must accept that complete destination instead of failing startup.
        Effect.catch((cause) =>
          fs
            .exists(starcodeHome)
            .pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(cause)))),
        ),
      ),
    ),
    Effect.ensuring(fs.remove(stagingHome, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});
