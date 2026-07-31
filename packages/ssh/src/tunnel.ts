import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@starcode/contracts";
import {
  describeReadinessCause,
  waitForHttpReady as waitForHttpReadyShared,
} from "@starcode/shared/httpReadiness";
import * as NetService from "@starcode/shared/Net";
import { extractJsonObject, fromLenientJson } from "@starcode/shared/schemaJson";
import { satisfiesSemverRange } from "@starcode/shared/semver";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSshChildEnvironment,
  type SshAuthOptions,
  SshPasswordPrompt,
  isSshAuthFailure,
} from "./auth.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  remoteStateKey,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

export const DEFAULT_REMOTE_PORT = 3773;
export const REMOTE_BOOTSTRAP_NODE_VERSION = "24.13.1";
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const REMOTE_READY_TIMEOUT_MS = 15_000;
const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;
const REMOTE_SOURCE_PREPARE_TIMEOUT_MS = 15 * 60_000;
const REMOTE_SOURCE_PACKAGE_MANAGER_VERSION = "11.10.0";

export interface RemoteStarcodeRunnerOptions {
  readonly packageSpec?: string;
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  readonly sourceCheckout?: {
    readonly repositoryUrl: string;
    readonly archiveBaseUrl: string;
    readonly commitApiBaseUrl: string;
    readonly archiveRootPrefix: string;
    readonly ref: string;
  };
}

export interface SshEnvironmentManagerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<RemoteStarcodeRunnerOptions>;
}

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly bindHost: "127.0.0.1" | "0.0.0.0";
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

function makeSshTunnelCancelledError(target: DesktopSshEnvironmentTarget): SshCommandError {
  return new SshCommandError({
    command: ["ssh"],
    exitCode: null,
    stderr: "",
    message: `SSH environment connection was cancelled for ${target.alias || target.hostname}.`,
  });
}

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function sshRunnerLogFields(runner: RemoteStarcodeRunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.sourceCheckout) {
    return { runner: "fork-source", sourceRef: runner.sourceCheckout.ref };
  }
  if (runner?.packageSpec?.trim()) {
    return { runner: "package", packageSpec: runner.packageSpec.trim() };
  }
  return { runner: "default" };
}

interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: {
      readonly issuePairingToken?: boolean;
      readonly networkAccessible?: boolean;
    },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
  serverKind: Schema.optional(Schema.Literals(["external", "managed"])),
  bindHost: Schema.optional(Schema.Literals(["127.0.0.1", "0.0.0.0"])),
});

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));

const decodeRemoteJsonOutput = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) {
          return yield* Effect.fail(error);
        }
        const exit = yield* Effect.exit(decode(jsonObject));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

const decodeRemotePairingOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemotePairingResult);

const remoteNodeEngineCheckMain = function remoteNodeEngineCheckMain() {
  const range = process.argv[2] || "";
  const rawVersion =
    process.versions && process.versions.node ? process.versions.node : process.version;

  if (!satisfiesSemverRange(rawVersion, range)) {
    process.stderr.write(
      "Remote node " + rawVersion + " does not satisfy required range " + range + ".\n",
    );
    process.exit(1);
  }
};

function buildRemoteNodeEngineCheckScript(): string {
  return `${satisfiesSemverRange.toString()}
(${remoteNodeEngineCheckMain.toString()})();`;
}

export function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`@@${token}@@`, value);
  }
  return result;
}

// Re-exported from the shared HTTP readiness module so existing importers
// (notably tunnel.test.ts) keep resolving it from here.
export { describeReadinessCause };

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = await tryPort(port);
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

export const REMOTE_WAIT_READY_SCRIPT = `const http = require("node:http");
const port = Number.parseInt(process.argv[2] ?? "", 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? "", 10);
const probeTimeoutMs = Number.parseInt(process.argv[4] ?? "", 10);
if (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {
  process.exit(1);
}
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        timeout: probeTimeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

(async () => {
  while (Date.now() < deadline) {
    if (await probe()) {
      process.exit(0);
    }
    await sleep(100);
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

export const REMOTE_NODE_ENV_SCRIPT = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

remote_node_satisfies_engine() {
  STARCODE_NODE_ENGINE_RANGE=@@STARCODE_NODE_ENGINE_RANGE@@
  if [ -z "$STARCODE_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$STARCODE_NODE_ENGINE_RANGE" <<'NODE'
@@STARCODE_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

bootstrap_remote_node_runtime() (
  set -eu
  STARCODE_NODE_VERSION=@@STARCODE_BOOTSTRAP_NODE_VERSION@@
  STARCODE_NODE_ROOT="$HOME/.starcode/runtime"
  STARCODE_NODE_TARGET="$STARCODE_NODE_ROOT/node-v$STARCODE_NODE_VERSION"
  STARCODE_KERNEL="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  STARCODE_MACHINE="$(uname -m 2>/dev/null)"
  case "$STARCODE_KERNEL" in
    linux) STARCODE_NODE_PLATFORM=linux ;;
    darwin) STARCODE_NODE_PLATFORM=darwin ;;
    *)
      printf 'Automatic StarCode Node.js bootstrap does not support %s.\\n' "$STARCODE_KERNEL" >&2
      exit 1
      ;;
  esac
  case "$STARCODE_MACHINE" in
    x86_64|amd64) STARCODE_NODE_ARCH=x64 ;;
    arm64|aarch64) STARCODE_NODE_ARCH=arm64 ;;
    *)
      printf 'Automatic StarCode Node.js bootstrap does not support architecture %s.\\n' "$STARCODE_MACHINE" >&2
      exit 1
      ;;
  esac
  STARCODE_NODE_ARCHIVE="node-v$STARCODE_NODE_VERSION-$STARCODE_NODE_PLATFORM-$STARCODE_NODE_ARCH.tar.gz"
  STARCODE_NODE_BASE_URL="https://nodejs.org/dist/v$STARCODE_NODE_VERSION"
  mkdir -p "$STARCODE_NODE_ROOT"
  if [ -x "$STARCODE_NODE_TARGET/bin/node" ]; then
    exit 0
  fi
  if ! command -v tar >/dev/null 2>&1; then
    printf 'Automatic StarCode Node.js bootstrap requires tar.\\n' >&2
    exit 1
  fi
  STARCODE_NODE_TMP="$(mktemp -d "$STARCODE_NODE_ROOT/bootstrap.XXXXXX")"
  trap 'rm -rf "$STARCODE_NODE_TMP"' EXIT HUP INT TERM
  download_node_file() {
    STARCODE_DOWNLOAD_URL="$1"
    STARCODE_DOWNLOAD_PATH="$2"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 2 "$STARCODE_DOWNLOAD_URL" -o "$STARCODE_DOWNLOAD_PATH"
    elif command -v wget >/dev/null 2>&1; then
      wget -q "$STARCODE_DOWNLOAD_URL" -O "$STARCODE_DOWNLOAD_PATH"
    else
      printf 'Automatic StarCode Node.js bootstrap requires curl or wget.\\n' >&2
      return 1
    fi
  }
  download_node_file "$STARCODE_NODE_BASE_URL/$STARCODE_NODE_ARCHIVE" "$STARCODE_NODE_TMP/$STARCODE_NODE_ARCHIVE"
  download_node_file "$STARCODE_NODE_BASE_URL/SHASUMS256.txt" "$STARCODE_NODE_TMP/SHASUMS256.txt"
  STARCODE_NODE_EXPECTED="$(awk -v archive="$STARCODE_NODE_ARCHIVE" '$2 == archive { print $1; exit }' "$STARCODE_NODE_TMP/SHASUMS256.txt")"
  if [ -z "$STARCODE_NODE_EXPECTED" ]; then
    printf 'Node.js did not publish a checksum for %s.\\n' "$STARCODE_NODE_ARCHIVE" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    STARCODE_NODE_ACTUAL="$(sha256sum "$STARCODE_NODE_TMP/$STARCODE_NODE_ARCHIVE" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    STARCODE_NODE_ACTUAL="$(shasum -a 256 "$STARCODE_NODE_TMP/$STARCODE_NODE_ARCHIVE" | awk '{print $1}')"
  else
    printf 'Automatic StarCode Node.js bootstrap requires sha256sum or shasum.\\n' >&2
    exit 1
  fi
  if [ "$STARCODE_NODE_ACTUAL" != "$STARCODE_NODE_EXPECTED" ]; then
    printf 'Downloaded Node.js archive failed checksum verification.\\n' >&2
    exit 1
  fi
  mkdir -p "$STARCODE_NODE_TMP/extracted"
  tar -xzf "$STARCODE_NODE_TMP/$STARCODE_NODE_ARCHIVE" -C "$STARCODE_NODE_TMP/extracted" --strip-components=1
  if [ ! -x "$STARCODE_NODE_TMP/extracted/bin/node" ]; then
    printf 'Downloaded Node.js archive did not contain the expected runtime.\\n' >&2
    exit 1
  fi
  if [ ! -d "$STARCODE_NODE_TARGET" ]; then
    mv "$STARCODE_NODE_TMP/extracted" "$STARCODE_NODE_TARGET"
  fi
)

ensure_remote_node_path() {
  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "$HOME/.starcode/runtime/node-v@@STARCODE_BOOTSTRAP_NODE_VERSION@@/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for STARCODE_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$STARCODE_NODE_BIN/node" ]; then
        PATH="$STARCODE_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;

export const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
@@STARCODE_NODE_ENV_SCRIPT@@
ensure_remote_node_path || true
STARCODE_NODE_SCRIPT_PATH=@@STARCODE_NODE_SCRIPT_PATH@@
STARCODE_SOURCE_REPOSITORY=@@STARCODE_SOURCE_REPOSITORY@@
STARCODE_SOURCE_ARCHIVE_BASE_URL=@@STARCODE_SOURCE_ARCHIVE_BASE_URL@@
STARCODE_SOURCE_COMMIT_API_BASE_URL=@@STARCODE_SOURCE_COMMIT_API_BASE_URL@@
STARCODE_SOURCE_ARCHIVE_ROOT_PREFIX=@@STARCODE_SOURCE_ARCHIVE_ROOT_PREFIX@@
STARCODE_SOURCE_REF=@@STARCODE_SOURCE_REF@@
STARCODE_SOURCE_ROOT="$HOME/.starcode/runtime/fork-source"
STARCODE_SOURCE_KEY=""
STARCODE_SOURCE_ENTRY=""
if [ -n "$STARCODE_SOURCE_REPOSITORY" ] &&
  [ -n "$STARCODE_SOURCE_ARCHIVE_BASE_URL" ] &&
  [ -n "$STARCODE_SOURCE_COMMIT_API_BASE_URL" ] &&
  [ -n "$STARCODE_SOURCE_ARCHIVE_ROOT_PREFIX" ] &&
  [ -n "$STARCODE_SOURCE_REF" ]; then
  STARCODE_SOURCE_KEY="$(printf '%s\\n%s\\n' "$STARCODE_SOURCE_REPOSITORY" "$STARCODE_SOURCE_REF" | cksum | awk '{print $1}')"
  STARCODE_SOURCE_ENTRY="$STARCODE_SOURCE_ROOT/$STARCODE_SOURCE_KEY/apps/server/dist/bin.mjs"
fi
prepare_starcode_source_checkout() (
  set -eu
  if [ -z "$STARCODE_SOURCE_ENTRY" ]; then
    exit 0
  fi
  STARCODE_SOURCE_TARGET="$STARCODE_SOURCE_ROOT/$STARCODE_SOURCE_KEY"
  STARCODE_SOURCE_REF_FILE="$STARCODE_SOURCE_TARGET/.starcode-source-ref"
  STARCODE_SOURCE_COMMIT_FILE="$STARCODE_SOURCE_TARGET/.starcode-source-commit"
  if ! command -v npx >/dev/null 2>&1; then
    printf 'The StarCode fork installer requires npm/npx on the remote host.\\n' >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    printf 'The StarCode fork installer requires tar on the remote host.\\n' >&2
    exit 1
  fi
  run_starcode_privileged() {
    if [ "$(id -u)" -eq 0 ]; then
      "$@"
      return
    fi
    sudo -n "$@"
  }
  ensure_remote_build_tools() {
    if command -v make >/dev/null 2>&1 && command -v c++ >/dev/null 2>&1; then
      return
    fi
    if [ "$(id -u)" -ne 0 ] &&
      { ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; }; then
      printf 'The StarCode fork installer needs make and a C++ compiler. Install build tools or allow passwordless sudo for onboarding.\\n' >&2
      exit 1
    fi
    if command -v apt-get >/dev/null 2>&1; then
      run_starcode_privileged env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run_starcode_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential
    elif command -v apk >/dev/null 2>&1; then
      run_starcode_privileged apk add --no-cache build-base
    elif command -v dnf >/dev/null 2>&1; then
      run_starcode_privileged dnf install -y make gcc-c++
    elif command -v yum >/dev/null 2>&1; then
      run_starcode_privileged yum install -y make gcc-c++
    elif command -v pacman >/dev/null 2>&1; then
      run_starcode_privileged pacman -Sy --noconfirm --needed base-devel
    else
      printf 'The StarCode fork installer needs make and a C++ compiler, and could not identify a supported package manager.\\n' >&2
      exit 1
    fi
    if ! command -v make >/dev/null 2>&1 || ! command -v c++ >/dev/null 2>&1; then
      printf 'The StarCode fork installer could not prepare make and a C++ compiler.\\n' >&2
      exit 1
    fi
  }
  mkdir -p "$STARCODE_SOURCE_ROOT"
  STARCODE_SOURCE_STAGING="$STARCODE_SOURCE_ROOT/.staging.$STARCODE_SOURCE_KEY.$$"
  trap 'rm -rf "$STARCODE_SOURCE_STAGING"' EXIT HUP INT TERM
  rm -rf "$STARCODE_SOURCE_STAGING"
  mkdir -p "$STARCODE_SOURCE_STAGING"
  download_starcode_source_file() {
    STARCODE_DOWNLOAD_URL="$1"
    STARCODE_DOWNLOAD_PATH="$2"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 2 "$STARCODE_DOWNLOAD_URL" -o "$STARCODE_DOWNLOAD_PATH"
    elif command -v wget >/dev/null 2>&1; then
      wget -q "$STARCODE_DOWNLOAD_URL" -O "$STARCODE_DOWNLOAD_PATH"
    else
      printf 'The StarCode fork installer requires curl or wget on the remote host.\\n' >&2
      return 1
    fi
  }
  case "$STARCODE_SOURCE_REF" in
    *[!0-9a-fA-F]*|'')
      STARCODE_SOURCE_REF_ENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$STARCODE_SOURCE_REF")"
      STARCODE_SOURCE_COMMIT_JSON="$STARCODE_SOURCE_STAGING/commit.json"
      download_starcode_source_file "$STARCODE_SOURCE_COMMIT_API_BASE_URL/$STARCODE_SOURCE_REF_ENCODED" "$STARCODE_SOURCE_COMMIT_JSON"
      STARCODE_SOURCE_COMMIT="$(node - "$STARCODE_SOURCE_COMMIT_JSON" <<'NODE'
const fs = require("node:fs");
const inputPath = process.argv[2];
try {
  const sha = JSON.parse(fs.readFileSync(inputPath, "utf8")).sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    process.exit(1);
  }
  process.stdout.write(sha.toLowerCase());
} catch {
  process.exit(1);
}
NODE
)"
      ;;
    *)
      if [ "\${#STARCODE_SOURCE_REF}" -eq 40 ]; then
        STARCODE_SOURCE_COMMIT="$(printf '%s' "$STARCODE_SOURCE_REF" | tr '[:upper:]' '[:lower:]')"
      else
        STARCODE_SOURCE_REF_ENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$STARCODE_SOURCE_REF")"
        STARCODE_SOURCE_COMMIT_JSON="$STARCODE_SOURCE_STAGING/commit.json"
        download_starcode_source_file "$STARCODE_SOURCE_COMMIT_API_BASE_URL/$STARCODE_SOURCE_REF_ENCODED" "$STARCODE_SOURCE_COMMIT_JSON"
        STARCODE_SOURCE_COMMIT="$(node - "$STARCODE_SOURCE_COMMIT_JSON" <<'NODE'
const fs = require("node:fs");
const inputPath = process.argv[2];
try {
  const sha = JSON.parse(fs.readFileSync(inputPath, "utf8")).sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    process.exit(1);
  }
  process.stdout.write(sha.toLowerCase());
} catch {
  process.exit(1);
}
NODE
)"
      fi
      ;;
  esac
  if [ -x "$STARCODE_SOURCE_ENTRY" ] &&
    [ "$(cat "$STARCODE_SOURCE_REF_FILE" 2>/dev/null || true)" = "$STARCODE_SOURCE_REF" ] &&
    [ "$(cat "$STARCODE_SOURCE_COMMIT_FILE" 2>/dev/null || true)" = "$STARCODE_SOURCE_COMMIT" ]; then
    exit 0
  fi
  STARCODE_SOURCE_ARCHIVE="$STARCODE_SOURCE_STAGING/source.tar.gz"
  download_starcode_source_file "$STARCODE_SOURCE_ARCHIVE_BASE_URL/$STARCODE_SOURCE_COMMIT" "$STARCODE_SOURCE_ARCHIVE"
  STARCODE_SOURCE_EXPECTED_ROOT="$STARCODE_SOURCE_ARCHIVE_ROOT_PREFIX$STARCODE_SOURCE_COMMIT"
  STARCODE_SOURCE_ARCHIVE_ROOT="$(tar -tzf "$STARCODE_SOURCE_ARCHIVE" | head -n 1 | cut -d/ -f1)"
  if [ "$STARCODE_SOURCE_ARCHIVE_ROOT" != "$STARCODE_SOURCE_EXPECTED_ROOT" ]; then
    printf 'The downloaded StarCode source archive did not match the resolved commit.\\n' >&2
    exit 1
  fi
  tar -xzf "$STARCODE_SOURCE_ARCHIVE" -C "$STARCODE_SOURCE_STAGING" --strip-components=1
  rm -f "$STARCODE_SOURCE_ARCHIVE" "$STARCODE_SOURCE_STAGING/commit.json"
  (
    cd "$STARCODE_SOURCE_STAGING"
    ensure_remote_build_tools
    NPM_CONFIG_UPDATE_NOTIFIER=false npx --yes pnpm@@@STARCODE_SOURCE_PACKAGE_MANAGER_VERSION@@ \\
      --filter @starcode/monorepo \\
      --filter @starcode/scripts... \\
      --filter starcode... \\
      install --frozen-lockfile --ignore-scripts --reporter=append-only
    NPM_CONFIG_UPDATE_NOTIFIER=false npx --yes pnpm@@@STARCODE_SOURCE_PACKAGE_MANAGER_VERSION@@ \\
      --filter @starcode/monorepo \\
      --filter @starcode/scripts... \\
      --filter starcode... \\
      rebuild esbuild msgpackr-extract node-pty sharp
    "$STARCODE_SOURCE_STAGING/node_modules/.bin/vp" run --filter starcode build
  )
  if [ ! -x "$STARCODE_SOURCE_STAGING/apps/server/dist/bin.mjs" ]; then
    printf 'The StarCode fork checkout built without a runnable server entry.\\n' >&2
    exit 1
  fi
  node "$STARCODE_SOURCE_STAGING/apps/server/dist/bin.mjs" --version >/dev/null
  printf '%s\\n' "$STARCODE_SOURCE_REF" >"$STARCODE_SOURCE_STAGING/.starcode-source-ref"
  printf '%s\\n' "$STARCODE_SOURCE_COMMIT" >"$STARCODE_SOURCE_STAGING/.starcode-source-commit"
  rm -rf "$STARCODE_SOURCE_TARGET"
  mv "$STARCODE_SOURCE_STAGING" "$STARCODE_SOURCE_TARGET"
  trap - EXIT HUP INT TERM
)
if [ "\${1:-}" = "__starcode_prepare__" ]; then
  prepare_starcode_source_checkout
  exit 0
fi
if [ -n "$STARCODE_NODE_SCRIPT_PATH" ]; then
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$STARCODE_NODE_SCRIPT_PATH" "$@"
fi
if [ -n "$STARCODE_SOURCE_ENTRY" ]; then
  prepare_starcode_source_checkout
  exec node "$STARCODE_SOURCE_ENTRY" "$@"
fi
if command -v starcode >/dev/null 2>&1; then
  exec starcode "$@"
fi
if command -v npx >/dev/null 2>&1; then
  exec npx --yes @@STARCODE_PACKAGE_SPEC@@ "$@"
fi
if command -v npm >/dev/null 2>&1; then
  exec npm exec --yes @@STARCODE_PACKAGE_SPEC@@ -- "$@"
fi
printf 'Remote host is missing the starcode CLI and could not install @@STARCODE_PACKAGE_SPEC@@ because node/npm/npx are unavailable on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
exit 1
`;

export const REMOTE_LAUNCH_SCRIPT = `set -eu
@@STARCODE_NODE_ENV_SCRIPT@@
STATE_KEY="$1"
BIND_HOST="\${2:-127.0.0.1}"
STATE_DIR="$HOME/.starcode/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="$HOME/.starcode"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
BIND_FILE="$STATE_DIR/bind-host"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
mkdir -p "$STATE_DIR"
cleanup_runner_next() {
  rm -f "$RUNNER_NEXT"
}
trap cleanup_runner_next EXIT
cat >"$RUNNER_NEXT" <<'SH'
@@STARCODE_RUNNER_SCRIPT@@
SH
RUNNER_CHANGED=0
if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  RUNNER_CHANGED=1
fi
mv "$RUNNER_NEXT" "$RUNNER_FILE"
chmod 700 "$RUNNER_FILE"
if ! ensure_remote_node_path; then
  printf 'Installing the StarCode Node.js runtime on the remote host.\\n' >&2
  if ! bootstrap_remote_node_runtime || ! ensure_remote_node_path; then
    printf 'Remote host is missing a supported Node.js runtime and automatic bootstrap failed.\\n' >&2
    exit 1
  fi
fi
"$RUNNER_FILE" __starcode_prepare__
pick_port() {
  node - "$PORT_FILE" "@@STARCODE_DEFAULT_REMOTE_PORT@@" "@@STARCODE_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@STARCODE_PICK_PORT_SCRIPT@@
NODE
}
wait_ready() {
  node - "$REMOTE_PORT" "$1" "@@STARCODE_READY_PROBE_TIMEOUT_MS@@" <<'NODE'
@@STARCODE_WAIT_READY_SCRIPT@@
NODE
}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_COUNT=0
  while kill -0 "$PID_TO_WAIT" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
resolve_default_runtime_port() {
  node - "$DEFAULT_RUNTIME_FILE" <<'NODE'
const fs = require("node:fs");
const runtimePath = process.argv[2] ?? "";
try {
	  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
	  const pid = Number(runtime.pid);
	  const port = Number(runtime.port);
	  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
	    process.exit(1);
	  }
  const origin = new URL(String(runtime.origin ?? ""));
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    process.exit(1);
  }
  process.kill(pid, 0);
  process.stdout.write(\`\${pid} \${port}\`);
} catch {
  process.exit(1);
}
NODE
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_BIND_HOST="$(cat "$BIND_FILE" 2>/dev/null || true)"
if [ -z "$REMOTE_BIND_HOST" ]; then
  REMOTE_BIND_HOST=127.0.0.1
fi
if [ "$REMOTE_BIND_HOST" = "0.0.0.0" ] && [ "$BIND_HOST" = "127.0.0.1" ]; then
  BIND_HOST="$REMOTE_BIND_HOST"
fi
DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port 2>/dev/null || true)"
DEFAULT_RUNTIME_PID=""
DEFAULT_REMOTE_PORT=""
if [ -n "$DEFAULT_RUNTIME_INFO" ]; then
  DEFAULT_RUNTIME_PID="\${DEFAULT_RUNTIME_INFO%% *}"
  DEFAULT_REMOTE_PORT="\${DEFAULT_RUNTIME_INFO#* }"
fi
if [ -n "$DEFAULT_REMOTE_PORT" ] && [ "$BIND_HOST" = "127.0.0.1" ]; then
  REMOTE_PORT="$DEFAULT_REMOTE_PORT"
  if wait_ready "@@STARCODE_REUSE_READY_TIMEOUT_MS@@"; then
    if [ "$REMOTE_MANAGED" = "managed" ]; then
      PID_TO_STOP="\${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"
      if [ -n "$PID_TO_STOP" ] && kill -0 "$PID_TO_STOP" 2>/dev/null; then
        kill "$PID_TO_STOP" 2>/dev/null || true
        wait_for_pid_exit "$PID_TO_STOP"
      fi
      REMOTE_PID=""
      REMOTE_PORT="$DEFAULT_REMOTE_PORT"
      REMOTE_MANAGED="external"
      rm -f "$PID_FILE" "$BIND_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    else
      rm -f "$BIND_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
      REMOTE_PID=""
      REMOTE_MANAGED="external"
    fi
  else
    REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
    REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
  fi
fi
if [ "$BIND_HOST" = "0.0.0.0" ] && [ "$REMOTE_BIND_HOST" != "0.0.0.0" ]; then
  if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
  fi
  REMOTE_PID=""
  REMOTE_PORT=""
  REMOTE_MANAGED=""
  REMOTE_BIND_HOST="$BIND_HOST"
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$BIND_FILE"
fi
if [ "$REMOTE_MANAGED" = "external" ]; then
  if [ -z "$REMOTE_PORT" ] || ! wait_ready "@@STARCODE_REUSE_READY_TIMEOUT_MS@@"; then
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
elif [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  if [ "$RUNNER_CHANGED" -eq 1 ]; then
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  elif ! wait_ready "@@STARCODE_REUSE_READY_TIMEOUT_MS@@"; then
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
else
  REMOTE_PID=""
  REMOTE_PORT=""
  REMOTE_MANAGED=""
fi
if [ -z "$REMOTE_PORT" ]; then
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    exit 1
  fi
  nohup env STARCODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host "$BIND_HOST" --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  printf '%s\\n' "$BIND_HOST" >"$BIND_FILE"
  REMOTE_BIND_HOST="$BIND_HOST"
  if ! wait_ready "@@STARCODE_READY_TIMEOUT_MS@@"; then
    printf 'Remote starcode server did not become ready on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$BIND_FILE"
    exit 1
  fi
fi
if [ "$REMOTE_MANAGED" = "external" ]; then
  REMOTE_BIND_HOST=127.0.0.1
fi
printf '{"remotePort":%s,"serverKind":"%s","bindHost":"%s"}\\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}" "$REMOTE_BIND_HOST"
`;

export const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="$HOME/.starcode/ssh-launch/@@STARCODE_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.starcode"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR"
cat >"$RUNNER_FILE" <<'SH'
@@STARCODE_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_FILE"
PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
`;

export const REMOTE_STOP_SCRIPT = `set -eu
STATE_DIR="$HOME/.starcode/ssh-launch/@@STARCODE_STATE_KEY@@"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
BIND_FILE="$STATE_DIR/bind-host"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  kill "$REMOTE_PID" 2>/dev/null || true
  WAIT_COUNT=0
  while kill -0 "$REMOTE_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$BIND_FILE"
printf '{"stopped":true}\\n'
`;

const REMOTE_LOG_TAIL_SCRIPT = `set -eu
STATE_DIR="$HOME/.starcode/ssh-launch/@@STARCODE_STATE_KEY@@"
LOG_FILE="$STATE_DIR/server.log"
if [ -f "$LOG_FILE" ]; then
  tail -n 80 "$LOG_FILE" 2>/dev/null || true
fi
`;

export function buildRemoteStarcodeRunnerScript(input?: RemoteStarcodeRunnerOptions): string {
  const packageSpec = shellSingleQuote(input?.packageSpec?.trim() || "t3@latest");
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  const sourceRepository = input?.sourceCheckout?.repositoryUrl.trim() || "";
  const sourceArchiveBaseUrl = input?.sourceCheckout?.archiveBaseUrl.trim() || "";
  const sourceCommitApiBaseUrl = input?.sourceCheckout?.commitApiBaseUrl.trim() || "";
  const sourceArchiveRootPrefix = input?.sourceCheckout?.archiveRootPrefix.trim() || "";
  const sourceRef = input?.sourceCheckout?.ref.trim() || "";
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      STARCODE_PACKAGE_SPEC: packageSpec,
      STARCODE_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      STARCODE_SOURCE_ARCHIVE_BASE_URL: shellSingleQuote(sourceArchiveBaseUrl),
      STARCODE_SOURCE_ARCHIVE_ROOT_PREFIX: shellSingleQuote(sourceArchiveRootPrefix),
      STARCODE_SOURCE_COMMIT_API_BASE_URL: shellSingleQuote(sourceCommitApiBaseUrl),
      STARCODE_SOURCE_PACKAGE_MANAGER_VERSION: REMOTE_SOURCE_PACKAGE_MANAGER_VERSION,
      STARCODE_SOURCE_REPOSITORY: shellSingleQuote(sourceRepository),
      STARCODE_SOURCE_REF: shellSingleQuote(sourceRef),
      STARCODE_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    }),
  );
}

export function buildRemoteNodeEnvScript(input?: RemoteStarcodeRunnerOptions): string {
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_NODE_ENV_SCRIPT, {
      STARCODE_BOOTSTRAP_NODE_VERSION: REMOTE_BOOTSTRAP_NODE_VERSION,
      STARCODE_NODE_ENGINE_RANGE: shellSingleQuote(input?.nodeEngineRange?.trim() || ""),
      STARCODE_NODE_ENGINE_CHECK_SCRIPT: stripTrailingNewlines(buildRemoteNodeEngineCheckScript()),
    }),
  );
}

export function buildRemoteLaunchScript(input?: RemoteStarcodeRunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    STARCODE_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    STARCODE_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteStarcodeRunnerScript(input)),
    STARCODE_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    STARCODE_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    STARCODE_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    STARCODE_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    STARCODE_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    STARCODE_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    STARCODE_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
  });
}

export function buildRemotePairingScript(
  target: DesktopSshEnvironmentTarget,
  input?: RemoteStarcodeRunnerOptions,
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    STARCODE_STATE_KEY: remoteStateKey(target),
    STARCODE_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteStarcodeRunnerScript(input)),
  });
}

export function buildRemoteStopScript(target: DesktopSshEnvironmentTarget): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    STARCODE_STATE_KEY: remoteStateKey(target),
  });
}

function buildRemoteLogTailScript(target: DesktopSshEnvironmentTarget): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    STARCODE_STATE_KEY: remoteStateKey(target),
  });
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuthOptions,
    runner?: RemoteStarcodeRunnerOptions,
    networkAccessible = false,
  ): Effect.fn.Return<
    {
      readonly remotePort: number;
      readonly remoteServerKind: "external" | "managed" | null;
      readonly bindHost: "127.0.0.1" | "0.0.0.0";
    },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey: remoteStateKey(target),
    });
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: [
        "sh",
        "-s",
        "--",
        remoteStateKey(target),
        networkAccessible ? "0.0.0.0" : "127.0.0.1",
      ],
      stdin: buildRemoteLaunchScript(runner),
      ...(runner?.sourceCheckout === undefined
        ? {}
        : { timeoutMs: REMOTE_SOURCE_PREPARE_TIMEOUT_MS }),
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      stateKey: remoteStateKey(target),
    });
    return {
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      bindHost: parsed.bindHost ?? (networkAccessible ? "0.0.0.0" : "127.0.0.1"),
    };
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: RemoteStarcodeRunnerOptions,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(target, runner),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  return {
    credential: parsed.credential,
  };
});

export const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(target),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
});

const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(target),
    timeoutMs: 10_000,
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  return result.stdout.trim();
});

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly lastFailure: unknown;
          };
          return new SshReadinessError({
            message: `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }
        const baseUrl = new URL(rawHttpBaseUrl);
        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }
        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService.NetService;
  return yield* net.reserveLoopbackPort();
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuthOptions;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly bindHost: "127.0.0.1" | "0.0.0.0";
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | Scope.Scope
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const tunnelCommand = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  yield* Effect.logDebug("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    bindHost: input.bindHost,
    httpBaseUrl: input.httpBaseUrl,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: {
          stream: Stream.empty,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: tunnelCommand,
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    );
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    bindHost: input.bindHost,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  };
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) => {
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      });
      return Effect.logWarning("ssh.tunnel.process.exited", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const processRunningExit = yield* Effect.exit(child.isRunning);
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, "127.0.0.1"),
        );
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, input.authOptions),
        );
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null;
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null;
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null;
        yield* Effect.logWarning("ssh.tunnel.ready.failed", {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        });
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const pendingTunnelEntries = new Map<
    string,
    Deferred.Deferred<SshTunnelEntry, SshEnvironmentEffectError>
  >();
  const authSecrets = new Map<string, string>();

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  const cancelPendingTunnelEntry = Effect.fn("ssh/tunnel.cancelPendingTunnelEntry")(function* (
    key: string,
    target: DesktopSshEnvironmentTarget,
  ) {
    const pending = pendingTunnelEntries.get(key);
    if (!pending) {
      return;
    }
    pendingTunnelEntries.delete(key);
    yield* Deferred.fail(pending, makeSshTunnelCancelledError(target)).pipe(Effect.ignore);
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => [...tunnels.values()]).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<string, SshInvalidTargetError | SshPasswordPromptError, SshPasswordPrompt> {
    const promptService = yield* SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshPasswordPrompt;
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    });
  });

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly runner?: RemoteStarcodeRunnerOptions;
    readonly networkAccessible: boolean;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const remoteLaunch = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        launchOrReuseRemoteServer(
          input.resolvedTarget,
          authOptions,
          input.runner,
          input.networkAccessible,
        ),
    });
    const remotePort = remoteLaunch.remotePort;
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
      bindHost: remoteLaunch.bindHost,
    });
    const localPort = yield* reserveLocalTunnelPort();
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    const entryScope = yield* Scope.make("sequential");
    const tunnelEntry = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
          remoteServerKind: remoteLaunch.remoteServerKind,
          bindHost: remoteLaunch.bindHost,
        }).pipe(Effect.provideService(Scope.Scope, entryScope)),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    tunnels.set(input.key, tunnelEntry);
    const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* Scope.addFinalizer(
      entryScope,
      Effect.gen(function* () {
        if (tunnels.get(tunnelEntry.key) !== tunnelEntry) {
          return;
        }
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.start", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
        tunnels.delete(tunnelEntry.key);
        const authSecret = authSecrets.get(tunnelEntry.key) ?? null;
        yield* Effect.all(
          [
            tunnelEntry.process.kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            }),
            stopRemoteServer(
              tunnelEntry.target,
              authSecret === null
                ? {
                    batchMode: "yes",
                    interactiveAuth: false,
                  }
                : {
                    authSecret,
                    batchMode: "no",
                    interactiveAuth: true,
                  },
            ).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
              Effect.provideService(FileSystem.FileSystem, fileSystemService),
              Effect.provideService(Path.Path, pathService),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.ignore);
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteStarcodeRunnerOptions,
    networkAccessible = false,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    let entry = tunnels.get(key) ?? null;

    if (entry !== null) {
      yield* Effect.logDebug("ssh.environment.tunnel.existing.check", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });
      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      );
      if (Exit.isSuccess(readinessExit) && (!networkAccessible || entry.bindHost === "0.0.0.0")) {
        yield* Effect.logDebug("ssh.environment.tunnel.reused", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
        });
        return entry;
      }
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        ...(Exit.isFailure(readinessExit) ? { cause: readinessExit.cause } : {}),
        bindHost: entry.bindHost,
        requiredBindHost: networkAccessible ? "0.0.0.0" : null,
      });
      yield* closeTunnelEntry(entry);
      yield* cancelPendingTunnelEntry(key, resolvedTarget);
      entry = null;
    }

    const pending = pendingTunnelEntries.get(key);
    if (pending) {
      yield* Effect.logDebug("ssh.environment.tunnel.pending.await", {
        ...sshTargetLogFields(resolvedTarget),
        key,
      });
      return yield* Deferred.await(pending);
    }

    const deferred = yield* Deferred.make<SshTunnelEntry, SshEnvironmentEffectError>();
    pendingTunnelEntries.set(key, deferred);

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      networkAccessible,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("ssh.environment.tunnel.create.failed", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (pendingTunnelEntries.get(key) === deferred) {
            pendingTunnelEntries.delete(key);
          }
        }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
      ),
    );
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: {
      readonly issuePairingToken?: boolean;
      readonly networkAccessible?: boolean;
    },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
      networkAccessible: requestOptions?.networkAccessible === true,
    });
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* Effect.logDebug("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    const packageSpec = options.resolveCliPackageSpec?.();
    const runner =
      options.resolveCliRunner === undefined
        ? packageSpec === undefined
          ? undefined
          : { packageSpec }
        : yield* options.resolveCliRunner;
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    const entry = yield* ensureTunnelEntry(
      key,
      resolvedTarget,
      runner,
      requestOptions?.networkAccessible === true,
    );

    const pairingResult = requestOptions?.issuePairingToken
      ? yield* runWithSshAuth({
          key,
          target: entry.target,
          operation: (authOptions) => issueRemotePairingToken(entry.target, authOptions, runner),
        })
      : null;
    const pairingToken = pairingResult?.credential ?? null;

    yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
      ...sshTargetLogFields(entry.target),
      key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
      remoteServerKind: entry.remoteServerKind,
      issuedPairingToken: pairingToken !== null,
    });
    return {
      target: entry.target,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
      pairingToken,
      remotePort: entry.remotePort,
      ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
    };
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    const entry = tunnels.get(key) ?? null;
    yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
      hasTunnel: entry !== null,
      hasPendingTunnel: pendingTunnelEntries.has(key),
    });
    if (entry !== null) {
      yield* closeTunnelEntry(entry);
    }
    yield* cancelPendingTunnelEntry(key, resolvedTarget);
    if (entry === null) {
      yield* runWithSshAuth({
        key,
        target: resolvedTarget,
        operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
      });
    }
    yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
  });

  return SshEnvironmentManager.of({ ensureEnvironment, disconnectEnvironment });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@starcode/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
