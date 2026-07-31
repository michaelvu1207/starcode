import type { DesktopSshEnvironmentTarget } from "@starcode/contracts";
import { satisfiesSemverRange } from "@starcode/shared/semver";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { SshAuthOptions } from "./auth.ts";
import { runSshCommand, type RunSshCommandOptions, type SshCommandResult } from "./command.ts";
import { SshCommandError, SshInvalidTargetError, SshPreflightParseError } from "./errors.ts";

export const DEFAULT_SSH_PREFLIGHT_PORT = 3773;
export const DEFAULT_SSH_PREFLIGHT_TIMEOUT_MS = 20_000;
export const STARCODE_NODE_VERSION_RANGE = "^22.16 || ^23.11 || >=24.10";
export const SSH_PREFLIGHT_PROTOCOL_HEADER = "STARCODE_PREFLIGHT_V1";
export const SSH_PREFLIGHT_PROTOCOL_FOOTER = "STARCODE_PREFLIGHT_END";

export type SshPreflightPlatform = "linux" | "darwin" | "windows" | "freebsd" | "unknown";
export type SshPreflightConnectionStatus = "reachable" | "unreachable" | "unknown";
export type SshPreflightAuthenticationStatus = "authenticated" | "rejected" | "unknown";
export type SshPreflightAvailability = "available" | "missing" | "unknown";
export type SshPreflightServiceStatus =
  | "running"
  | "stopped"
  | "not-installed"
  | "unsupported"
  | "unknown";
export type SshPreflightPortStatus = "available" | "occupied" | "unknown";
export type SshPreflightSeverity = "info" | "warning" | "error";
export type SshPreflightDiagnosticCategory =
  | "ssh-client-unavailable"
  | "host-unreachable"
  | "ssh-connection-failed"
  | "host-key-rejected"
  | "authentication-failed"
  | "remote-shell-unsupported"
  | "probe-output-invalid"
  | "unsupported-os"
  | "node-missing"
  | "node-version-unknown"
  | "node-version-unsupported"
  | "package-manager-missing"
  | "starcode-not-installed"
  | "starcode-service-not-installed"
  | "starcode-service-stopped"
  | "port-occupied"
  | "port-status-unknown"
  | "tailscale-missing"
  | "tailscale-not-running";
export type SshPreflightPackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export interface SshPreflightDiagnostic {
  readonly category: SshPreflightDiagnosticCategory;
  readonly severity: SshPreflightSeverity;
  readonly summary: string;
  readonly action: string;
}

export interface SshPreflightExecutable {
  readonly availability: SshPreflightAvailability;
  readonly path: string | null;
  readonly version: string | null;
}

export interface SshPreflightPackageManager extends SshPreflightExecutable {
  readonly name: SshPreflightPackageManagerName;
}

export interface SshRemotePreflightReport {
  readonly connection: {
    readonly reachability: SshPreflightConnectionStatus;
    readonly authentication: SshPreflightAuthenticationStatus;
  };
  readonly system: {
    readonly platform: SshPreflightPlatform;
    readonly name: string;
    readonly version: string;
    readonly architecture: string;
    readonly shell: {
      readonly path: string | null;
      readonly name: string | null;
    };
  } | null;
  readonly node: SshPreflightExecutable;
  readonly packageManagers: readonly SshPreflightPackageManager[];
  readonly starcode: SshPreflightExecutable & {
    readonly service: {
      readonly supported: boolean;
      readonly installed: boolean;
      readonly status: SshPreflightServiceStatus;
    };
  };
  readonly port: {
    readonly number: number;
    readonly status: SshPreflightPortStatus;
    readonly owner: string | null;
  };
  readonly tailscale: SshPreflightExecutable & {
    readonly backendState: string | null;
    readonly tailnetIpv4Addresses: readonly string[];
  };
  readonly diagnostics: readonly SshPreflightDiagnostic[];
  readonly readyForProvisioning: boolean;
}

export interface RunSshRemotePreflightOptions extends SshAuthOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
}

export type SshPreflightCommandError = SshCommandError | SshInvalidTargetError;

export type SshPreflightCommandRunner<R = never> = (
  target: DesktopSshEnvironmentTarget,
  options: RunSshCommandOptions,
) => Effect.Effect<SshCommandResult, SshPreflightCommandError, R>;

export const POSIX_REMOTE_PREFLIGHT_SCRIPT = `set +e
STARCODE_PREFLIGHT_PORT="$1"
emit_preflight() {
  STARCODE_PREFLIGHT_VALUE="$(printf '%s' "$2" | tr '\\r\\n\\t' '   ')"
  printf '%s\\t%s\\n' "$1" "$STARCODE_PREFLIGHT_VALUE"
}
printf '${SSH_PREFLIGHT_PROTOCOL_HEADER}\\n'

STARCODE_KERNEL="$(uname -s 2>/dev/null || true)"
STARCODE_OS_VERSION="$(uname -r 2>/dev/null || true)"
STARCODE_ARCH="$(uname -m 2>/dev/null || true)"
STARCODE_OS_NAME=""
if [ -r /etc/os-release ]; then
  STARCODE_OS_NAME="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | head -n 1 | sed 's/^"//;s/"$//')"
fi
if [ -z "$STARCODE_OS_NAME" ]; then
  STARCODE_OS_NAME="$STARCODE_KERNEL"
fi
STARCODE_SHELL_PATH="\${SHELL:-}"
if [ -z "$STARCODE_SHELL_PATH" ]; then
  STARCODE_SHELL_PATH="$(ps -p $$ -o comm= 2>/dev/null | tr -d ' ' || true)"
fi
STARCODE_SHELL_NAME="\${STARCODE_SHELL_PATH##*/}"
emit_preflight os.kernel "$STARCODE_KERNEL"
emit_preflight os.name "$STARCODE_OS_NAME"
emit_preflight os.version "$STARCODE_OS_VERSION"
emit_preflight os.arch "$STARCODE_ARCH"
emit_preflight shell.path "$STARCODE_SHELL_PATH"
emit_preflight shell.name "$STARCODE_SHELL_NAME"

for STARCODE_TOOL in node npm pnpm yarn bun; do
  STARCODE_TOOL_PATH="$(command -v "$STARCODE_TOOL" 2>/dev/null || true)"
  STARCODE_TOOL_VERSION=""
  if [ -n "$STARCODE_TOOL_PATH" ]; then
    STARCODE_TOOL_VERSION="$("$STARCODE_TOOL" --version 2>/dev/null | head -n 1 || true)"
  fi
  emit_preflight "$STARCODE_TOOL.path" "$STARCODE_TOOL_PATH"
  emit_preflight "$STARCODE_TOOL.version" "$STARCODE_TOOL_VERSION"
done

STARCODE_CLI_PATH="$(command -v starcode 2>/dev/null || true)"
STARCODE_CLI_VERSION=""
if [ -n "$STARCODE_CLI_PATH" ]; then
  STARCODE_CLI_VERSION="$(starcode --version 2>/dev/null | head -n 1 || true)"
fi
emit_preflight starcode.path "$STARCODE_CLI_PATH"
emit_preflight starcode.version "$STARCODE_CLI_VERSION"

STARCODE_SERVICE_SUPPORTED=false
STARCODE_SERVICE_INSTALLED=false
STARCODE_SERVICE_STATE=unsupported
if command -v systemctl >/dev/null 2>&1; then
  STARCODE_SERVICE_SUPPORTED=true
  STARCODE_SERVICE_STATE=not-installed
  if [ -f "$HOME/.config/systemd/user/starcode.service" ] || systemctl --user cat starcode.service >/dev/null 2>&1; then
    STARCODE_SERVICE_INSTALLED=true
    STARCODE_SERVICE_STATE="$(systemctl --user is-active starcode.service 2>/dev/null || true)"
    if [ -z "$STARCODE_SERVICE_STATE" ]; then
      STARCODE_SERVICE_STATE=unknown
    fi
  fi
fi
emit_preflight service.supported "$STARCODE_SERVICE_SUPPORTED"
emit_preflight service.installed "$STARCODE_SERVICE_INSTALLED"
emit_preflight service.state "$STARCODE_SERVICE_STATE"

STARCODE_PORT_STATUS=unknown
STARCODE_PORT_OWNER=""
if command -v node >/dev/null 2>&1; then
  STARCODE_PORT_STATUS="$(node -e 'const net=require("node:net");const server=net.createServer();server.once("error",()=>process.stdout.write("occupied"));server.listen(Number(process.argv[1]),"127.0.0.1",()=>server.close(()=>process.stdout.write("available")));' "$STARCODE_PREFLIGHT_PORT" 2>/dev/null || true)"
fi
if [ "$STARCODE_PORT_STATUS" = unknown ] || [ -z "$STARCODE_PORT_STATUS" ]; then
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$STARCODE_PREFLIGHT_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      STARCODE_PORT_STATUS=occupied
    else
      STARCODE_PORT_STATUS=available
    fi
  elif command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk -v suffix=":$STARCODE_PREFLIGHT_PORT" '$4 ~ suffix "$" { found=1 } END { exit !found }'; then
      STARCODE_PORT_STATUS=occupied
    else
      STARCODE_PORT_STATUS=available
    fi
  fi
fi
if [ "$STARCODE_PORT_STATUS" = occupied ] && command -v lsof >/dev/null 2>&1; then
  STARCODE_PORT_OWNER="$(lsof -nP -iTCP:"$STARCODE_PREFLIGHT_PORT" -sTCP:LISTEN -F c 2>/dev/null | sed -n 's/^c//p' | head -n 1)"
fi
emit_preflight port.status "$STARCODE_PORT_STATUS"
emit_preflight port.owner "$STARCODE_PORT_OWNER"

STARCODE_TAILSCALE_PATH="$(command -v tailscale 2>/dev/null || true)"
STARCODE_TAILSCALE_VERSION=""
STARCODE_TAILSCALE_STATE=""
STARCODE_TAILSCALE_IPV4=""
if [ -n "$STARCODE_TAILSCALE_PATH" ]; then
  STARCODE_TAILSCALE_VERSION="$(tailscale version 2>/dev/null | head -n 1 || true)"
  STARCODE_TAILSCALE_JSON="$(tailscale status --json 2>/dev/null || true)"
  STARCODE_TAILSCALE_STATE="$(printf '%s' "$STARCODE_TAILSCALE_JSON" | sed -n 's/.*"BackendState":[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
  STARCODE_TAILSCALE_IPV4="$(tailscale ip -4 2>/dev/null | paste -sd, - || true)"
fi
emit_preflight tailscale.path "$STARCODE_TAILSCALE_PATH"
emit_preflight tailscale.version "$STARCODE_TAILSCALE_VERSION"
emit_preflight tailscale.state "$STARCODE_TAILSCALE_STATE"
emit_preflight tailscale.ipv4 "$STARCODE_TAILSCALE_IPV4"
printf '${SSH_PREFLIGHT_PROTOCOL_FOOTER}\\n'
`;

function normalizePreflightPort(port: number | undefined): number {
  const resolved = port ?? DEFAULT_SSH_PREFLIGHT_PORT;
  return Number.isInteger(resolved) && resolved >= 1 && resolved <= 65_535
    ? resolved
    : DEFAULT_SSH_PREFLIGHT_PORT;
}

export function buildWindowsRemotePreflightScript(portInput?: number): string {
  const port = normalizePreflightPort(portInput);
  return `$ErrorActionPreference = "SilentlyContinue"
function Emit-Preflight([string]$Key, [object]$Value) {
  $Text = if ($null -eq $Value) { "" } else { [string]$Value }
  $Text = $Text -replace "[\\r\\n\\t]", " "
  Write-Output ($Key + "\`t" + $Text)
}
Write-Output "${SSH_PREFLIGHT_PROTOCOL_HEADER}"
$Os = Get-CimInstance Win32_OperatingSystem
Emit-Preflight "os.kernel" "Windows_NT"
Emit-Preflight "os.name" $Os.Caption
Emit-Preflight "os.version" $Os.Version
Emit-Preflight "os.arch" $env:PROCESSOR_ARCHITECTURE
Emit-Preflight "shell.path" (Get-Process -Id $PID).Path
Emit-Preflight "shell.name" "powershell"
foreach ($ToolName in @("node", "npm", "pnpm", "yarn", "bun")) {
  $Tool = Get-Command ($ToolName + ".exe") -ErrorAction SilentlyContinue
  if ($null -eq $Tool) { $Tool = Get-Command $ToolName -ErrorAction SilentlyContinue }
  $Version = if ($null -eq $Tool) { "" } else { (& $Tool.Source --version 2>$null | Select-Object -First 1) }
  Emit-Preflight ($ToolName + ".path") $(if ($null -eq $Tool) { "" } else { $Tool.Source })
  Emit-Preflight ($ToolName + ".version") $Version
}
$Starcode = Get-Command "starcode.exe" -ErrorAction SilentlyContinue
if ($null -eq $Starcode) { $Starcode = Get-Command "starcode" -ErrorAction SilentlyContinue }
$StarcodeVersion = if ($null -eq $Starcode) { "" } else { (& $Starcode.Source --version 2>$null | Select-Object -First 1) }
Emit-Preflight "starcode.path" $(if ($null -eq $Starcode) { "" } else { $Starcode.Source })
Emit-Preflight "starcode.version" $StarcodeVersion
Emit-Preflight "service.supported" "false"
Emit-Preflight "service.installed" "false"
Emit-Preflight "service.state" "unsupported"
$Listener = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1
Emit-Preflight "port.status" $(if ($null -eq $Listener) { "available" } else { "occupied" })
$OwnerName = ""
if ($null -ne $Listener) {
  $OwnerName = (Get-Process -Id $Listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
}
Emit-Preflight "port.owner" $OwnerName
$Tailscale = Get-Command "tailscale.exe" -ErrorAction SilentlyContinue
$TailscaleVersion = if ($null -eq $Tailscale) { "" } else { (& $Tailscale.Source version 2>$null | Select-Object -First 1) }
$TailscaleStatus = if ($null -eq $Tailscale) { $null } else { (& $Tailscale.Source status --json 2>$null | ConvertFrom-Json) }
$TailscaleIps = if ($null -eq $Tailscale) { "" } else { ((& $Tailscale.Source ip -4 2>$null) -join ",") }
Emit-Preflight "tailscale.path" $(if ($null -eq $Tailscale) { "" } else { $Tailscale.Source })
Emit-Preflight "tailscale.version" $TailscaleVersion
Emit-Preflight "tailscale.state" $(if ($null -eq $TailscaleStatus) { "" } else { $TailscaleStatus.BackendState })
Emit-Preflight "tailscale.ipv4" $TailscaleIps
Write-Output "${SSH_PREFLIGHT_PROTOCOL_FOOTER}"
`;
}

function normalizeOptionalValue(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function parseProtocolValues(stdout: string): ReadonlyMap<string, string> {
  const lines = stdout.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === SSH_PREFLIGHT_PROTOCOL_HEADER);
  if (start < 0) {
    throw new SshPreflightParseError({
      message: "SSH preflight output did not include its protocol header.",
    });
  }
  const values = new Map<string, string>();
  let foundFooter = false;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === SSH_PREFLIGHT_PROTOCOL_FOOTER) {
      foundFooter = true;
      break;
    }
    const separator = line.indexOf("\t");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key.length > 0 && !values.has(key)) {
      values.set(key, line.slice(separator + 1).trim());
    }
  }
  if (!foundFooter) {
    throw new SshPreflightParseError({
      message: "SSH preflight output ended before its protocol footer.",
    });
  }
  if (!values.has("os.kernel") || !values.has("port.status")) {
    throw new SshPreflightParseError({
      message: "SSH preflight output is missing required machine facts.",
    });
  }
  return values;
}

function platformFromKernel(kernel: string): SshPreflightPlatform {
  const normalized = kernel.trim().toLowerCase();
  if (normalized === "linux") return "linux";
  if (normalized === "darwin") return "darwin";
  if (normalized === "freebsd") return "freebsd";
  if (
    normalized === "windows_nt" ||
    normalized.startsWith("mingw") ||
    normalized.startsWith("msys") ||
    normalized.startsWith("cygwin")
  ) {
    return "windows";
  }
  return "unknown";
}

function executableFromValues(
  values: ReadonlyMap<string, string>,
  key: string,
): SshPreflightExecutable {
  const path = normalizeOptionalValue(values.get(`${key}.path`));
  return {
    availability: path === null ? "missing" : "available",
    path,
    version: normalizeOptionalValue(values.get(`${key}.version`)),
  };
}

function serviceStatusFromValue(value: string | undefined): SshPreflightServiceStatus {
  switch (value?.trim().toLowerCase()) {
    case "active":
    case "activating":
    case "running":
      return "running";
    case "inactive":
    case "deactivating":
    case "failed":
    case "stopped":
      return "stopped";
    case "not-installed":
      return "not-installed";
    case "unsupported":
      return "unsupported";
    default:
      return "unknown";
  }
}

function portStatusFromValue(value: string | undefined): SshPreflightPortStatus {
  switch (value?.trim().toLowerCase()) {
    case "available":
      return "available";
    case "occupied":
      return "occupied";
    default:
      return "unknown";
  }
}

function addInventoryDiagnostics(
  report: Omit<SshRemotePreflightReport, "diagnostics" | "readyForProvisioning">,
): readonly SshPreflightDiagnostic[] {
  const diagnostics: SshPreflightDiagnostic[] = [];
  if (report.system?.platform === "unknown" || report.system?.platform === "freebsd") {
    diagnostics.push({
      category: "unsupported-os",
      severity: "error",
      summary: "The remote operating system could not be identified.",
      action: "Use a Linux, macOS, or Windows host with a supported SSH shell.",
    });
  }
  if (report.node.availability !== "available") {
    diagnostics.push({
      category: "node-missing",
      severity: "error",
      summary: "Node.js is not available to the non-interactive SSH shell.",
      action: "Install Node.js 22.16 or newer and ensure it is on PATH for non-interactive SSH.",
    });
  } else if (report.node.version === null) {
    diagnostics.push({
      category: "node-version-unknown",
      severity: "warning",
      summary: "Node.js is available, but its version could not be read.",
      action: `Verify that Node.js satisfies ${STARCODE_NODE_VERSION_RANGE} before provisioning.`,
    });
  } else if (!satisfiesSemverRange(report.node.version, STARCODE_NODE_VERSION_RANGE)) {
    diagnostics.push({
      category: "node-version-unsupported",
      severity: "error",
      summary: `Node.js ${report.node.version} does not satisfy StarCode's runtime requirement.`,
      action: `Install a Node.js version satisfying ${STARCODE_NODE_VERSION_RANGE} and retry.`,
    });
  }
  if (report.packageManagers.length === 0 && report.starcode.availability !== "available") {
    diagnostics.push({
      category: "package-manager-missing",
      severity: "error",
      summary: "No supported JavaScript package manager is available.",
      action: "Install npm, pnpm, yarn, or Bun so StarCode can be installed remotely.",
    });
  }
  if (report.starcode.availability !== "available") {
    diagnostics.push({
      category: "starcode-not-installed",
      severity: "info",
      summary: "The StarCode CLI is not installed on the remote host.",
      action: "Install the current StarCode package after the prerequisite checks pass.",
    });
  } else if (
    report.starcode.service.supported &&
    report.starcode.service.status === "not-installed"
  ) {
    diagnostics.push({
      category: "starcode-service-not-installed",
      severity: "info",
      summary: "The StarCode CLI is installed, but its background service is not.",
      action: "Run `starcode service install` after confirming the desired StarCode version.",
    });
  } else if (report.starcode.service.status === "stopped") {
    diagnostics.push({
      category: "starcode-service-stopped",
      severity: "warning",
      summary: "The StarCode background service is installed but not running.",
      action: "Run `starcode service update` or start the user service before pairing.",
    });
  }
  if (report.port.status === "occupied" && report.starcode.service.status !== "running") {
    diagnostics.push({
      category: "port-occupied",
      severity: "error",
      summary: `Port ${report.port.number} is already occupied on the remote host.`,
      action: "Stop the conflicting process or select another StarCode port.",
    });
  } else if (report.port.status === "unknown") {
    diagnostics.push({
      category: "port-status-unknown",
      severity: "warning",
      summary: `Port ${report.port.number} could not be checked.`,
      action: "Install Node.js or a socket inspection tool, then retry the preflight.",
    });
  }
  if (report.tailscale.availability !== "available") {
    diagnostics.push({
      category: "tailscale-missing",
      severity: "error",
      summary: "Tailscale is not installed or is not on the remote PATH.",
      action: "Install Tailscale, join the fleet tailnet, and retry the preflight.",
    });
  } else if (report.tailscale.backendState?.toLowerCase() !== "running") {
    diagnostics.push({
      category: "tailscale-not-running",
      severity: "error",
      summary: "Tailscale is installed but its backend is not running.",
      action: "Start Tailscale and authenticate this machine to the fleet tailnet.",
    });
  }
  return diagnostics;
}

function reportFromValues(
  values: ReadonlyMap<string, string>,
  port: number,
): SshRemotePreflightReport {
  const platform = platformFromKernel(values.get("os.kernel") ?? "");
  const node = executableFromValues(values, "node");
  const packageManagers = (["npm", "pnpm", "yarn", "bun"] as const).flatMap((name) => {
    const executable = executableFromValues(values, name);
    return executable.availability === "available" ? [{ name, ...executable }] : [];
  });
  const starcodeExecutable = executableFromValues(values, "starcode");
  const serviceSupported = values.get("service.supported") === "true";
  const serviceInstalled = values.get("service.installed") === "true";
  const tailscaleExecutable = executableFromValues(values, "tailscale");
  const baseReport = {
    connection: {
      reachability: "reachable",
      authentication: "authenticated",
    },
    system: {
      platform,
      name: values.get("os.name") ?? "",
      version: values.get("os.version") ?? "",
      architecture: values.get("os.arch") ?? "",
      shell: {
        path: normalizeOptionalValue(values.get("shell.path")),
        name: normalizeOptionalValue(values.get("shell.name")),
      },
    },
    node,
    packageManagers,
    starcode: {
      ...starcodeExecutable,
      service: {
        supported: serviceSupported,
        installed: serviceInstalled,
        status: serviceStatusFromValue(values.get("service.state")),
      },
    },
    port: {
      number: port,
      status: portStatusFromValue(values.get("port.status")),
      owner: normalizeOptionalValue(values.get("port.owner")),
    },
    tailscale: {
      ...tailscaleExecutable,
      backendState: normalizeOptionalValue(values.get("tailscale.state")),
      tailnetIpv4Addresses: (values.get("tailscale.ipv4") ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter((address) => address.length > 0),
    },
  } satisfies Omit<SshRemotePreflightReport, "diagnostics" | "readyForProvisioning">;
  const diagnostics = addInventoryDiagnostics(baseReport);
  return {
    ...baseReport,
    diagnostics,
    readyForProvisioning: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
  };
}

export const parseSshRemotePreflightOutput = Effect.fn(
  "ssh.preflight.parseSshRemotePreflightOutput",
)(function* (
  stdout: string,
  portInput?: number,
): Effect.fn.Return<SshRemotePreflightReport, SshPreflightParseError> {
  return yield* Effect.try({
    try: () => reportFromValues(parseProtocolValues(stdout), normalizePreflightPort(portInput)),
    catch: (cause) =>
      cause instanceof SshPreflightParseError
        ? cause
        : new SshPreflightParseError({ message: "Failed to parse SSH preflight output." }),
  });
});

function failureText(error: SshPreflightCommandError): string {
  return error instanceof SshCommandError
    ? [error.message, error.stderr, error.stdout ?? ""].join("\n").toLowerCase()
    : error.message.toLowerCase();
}

function isMissingPosixShell(error: SshPreflightCommandError): boolean {
  if (!(error instanceof SshCommandError) || error.exitCode === null) {
    return false;
  }
  const text = failureText(error);
  return (
    /\bsh(?::|\.exe:)? (?:command )?not found\b/u.test(text) ||
    text.includes("'sh' is not recognized") ||
    text.includes("cannot find the file specified")
  );
}

function failureDiagnostic(error: SshPreflightCommandError): {
  readonly reachability: SshPreflightConnectionStatus;
  readonly authentication: SshPreflightAuthenticationStatus;
  readonly diagnostic: SshPreflightDiagnostic;
} {
  const text = failureText(error);
  if (
    text.includes("permission denied") ||
    text.includes("authentication failed") ||
    text.includes("too many authentication failures") ||
    text.includes("no supported authentication methods")
  ) {
    return {
      reachability: "reachable",
      authentication: "rejected",
      diagnostic: {
        category: "authentication-failed",
        severity: "error",
        summary: "The SSH host rejected the available credentials.",
        action: "Verify the SSH username, key, agent, or password and retry.",
      },
    };
  }
  if (
    text.includes("host key verification failed") ||
    text.includes("remote host identification has changed")
  ) {
    return {
      reachability: "unknown",
      authentication: "unknown",
      diagnostic: {
        category: "host-key-rejected",
        severity: "error",
        summary: "SSH host-key verification failed.",
        action: "Verify the machine identity and repair the corresponding known_hosts entry.",
      },
    };
  }
  if (
    text.includes("could not resolve hostname") ||
    text.includes("name or service not known") ||
    text.includes("nodename nor servname provided") ||
    text.includes("connection refused") ||
    text.includes("no route to host") ||
    text.includes("network is unreachable") ||
    text.includes("connection timed out") ||
    text.includes("operation timed out") ||
    text.includes("ssh command timed out")
  ) {
    return {
      reachability: "unreachable",
      authentication: "unknown",
      diagnostic: {
        category: "host-unreachable",
        severity: "error",
        summary: "The remote SSH endpoint could not be reached.",
        action:
          "Check the hostname, SSH port, network route, firewall, and whether sshd is running.",
      },
    };
  }
  if (
    error instanceof SshCommandError &&
    error.exitCode === null &&
    (text.includes("enoent") || text.includes("failed to spawn"))
  ) {
    return {
      reachability: "unknown",
      authentication: "unknown",
      diagnostic: {
        category: "ssh-client-unavailable",
        severity: "error",
        summary: "The local SSH client could not be started.",
        action: "Install or enable the OpenSSH client on this machine.",
      },
    };
  }
  return {
    reachability: "unknown",
    authentication: "unknown",
    diagnostic: {
      category: "ssh-connection-failed",
      severity: "error",
      summary: "SSH failed before the remote preflight completed.",
      action: "Test the same target with the system SSH client, resolve its error, and retry.",
    },
  };
}

function unavailableReport(input: {
  readonly port: number;
  readonly reachability: SshPreflightConnectionStatus;
  readonly authentication: SshPreflightAuthenticationStatus;
  readonly diagnostic: SshPreflightDiagnostic;
}): SshRemotePreflightReport {
  return {
    connection: {
      reachability: input.reachability,
      authentication: input.authentication,
    },
    system: null,
    node: { availability: "unknown", path: null, version: null },
    packageManagers: [],
    starcode: {
      availability: "unknown",
      path: null,
      version: null,
      service: { supported: false, installed: false, status: "unknown" },
    },
    port: { number: input.port, status: "unknown", owner: null },
    tailscale: {
      availability: "unknown",
      path: null,
      version: null,
      backendState: null,
      tailnetIpv4Addresses: [],
    },
    diagnostics: [input.diagnostic],
    readyForProvisioning: false,
  };
}

function invalidOutputReport(port: number): SshRemotePreflightReport {
  return unavailableReport({
    port,
    reachability: "reachable",
    authentication: "authenticated",
    diagnostic: {
      category: "probe-output-invalid",
      severity: "error",
      summary: "The remote host returned incomplete preflight data.",
      action: "Check the remote shell startup files for unexpected exits or output corruption.",
    },
  });
}

export const runSshRemotePreflightWith = Effect.fn("ssh.preflight.runSshRemotePreflightWith")(
  function* <R>(
    target: DesktopSshEnvironmentTarget,
    input: RunSshRemotePreflightOptions,
    runner: SshPreflightCommandRunner<R>,
  ): Effect.fn.Return<SshRemotePreflightReport, never, R> {
    const port = normalizePreflightPort(input.port);
    const commandOptions = {
      timeoutMs: input.timeoutMs ?? DEFAULT_SSH_PREFLIGHT_TIMEOUT_MS,
      ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    } satisfies RunSshCommandOptions;
    const posixResult = yield* runner(target, {
      ...commandOptions,
      remoteCommandArgs: ["sh", "-s", "--", String(port)],
      stdin: POSIX_REMOTE_PREFLIGHT_SCRIPT,
    }).pipe(Effect.result);

    if (Result.isSuccess(posixResult)) {
      const parsed = yield* parseSshRemotePreflightOutput(posixResult.success.stdout, port).pipe(
        Effect.result,
      );
      return Result.isSuccess(parsed) ? parsed.success : invalidOutputReport(port);
    }

    if (!isMissingPosixShell(posixResult.failure)) {
      const classified = failureDiagnostic(posixResult.failure);
      return unavailableReport({ port, ...classified });
    }

    const windowsResult = yield* runner(target, {
      ...commandOptions,
      remoteCommandArgs: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "-"],
      stdin: buildWindowsRemotePreflightScript(port),
    }).pipe(Effect.result);
    if (Result.isSuccess(windowsResult)) {
      const parsed = yield* parseSshRemotePreflightOutput(windowsResult.success.stdout, port).pipe(
        Effect.result,
      );
      return Result.isSuccess(parsed) ? parsed.success : invalidOutputReport(port);
    }

    return unavailableReport({
      port,
      reachability: "reachable",
      authentication: "authenticated",
      diagnostic: {
        category: "remote-shell-unsupported",
        severity: "error",
        summary:
          "SSH works, but neither a POSIX shell nor Windows PowerShell could run the preflight.",
        action: "Configure the SSH account with `sh` or Windows PowerShell and retry.",
      },
    });
  },
);

export const runSshRemotePreflight = Effect.fn("ssh.preflight.runSshRemotePreflight")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshRemotePreflightOptions = {},
): Effect.fn.Return<
  SshRemotePreflightReport,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return yield* runSshRemotePreflightWith(target, input, runSshCommand);
});
