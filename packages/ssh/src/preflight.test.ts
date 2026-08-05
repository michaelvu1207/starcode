// @effect-diagnostics preferSchemaOverJson:off - verifies that diagnostics redact raw failures.
import { assert, describe, it } from "@effect/vitest";
import type { DesktopSshEnvironmentTarget } from "@starcode/contracts";
import * as Effect from "effect/Effect";

import type { RunSshCommandOptions } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import {
  buildWindowsRemotePreflightScript,
  parseSshRemotePreflightOutput,
  runSshRemotePreflightWith,
  SSH_PREFLIGHT_PROTOCOL_FOOTER,
  SSH_PREFLIGHT_PROTOCOL_HEADER,
  type SshPreflightCommandRunner,
} from "./preflight.ts";

const target: DesktopSshEnvironmentTarget = {
  alias: "remote",
  hostname: "remote.example.com",
  username: "operator",
  port: 22,
};

function output(
  overrides: Readonly<Record<string, string>> = {},
  input?: { readonly windows?: boolean },
): string {
  const values: Record<string, string> = {
    "os.kernel": input?.windows ? "Windows_NT" : "Linux",
    "os.name": input?.windows ? "Microsoft Windows 11 Pro" : "Ubuntu 24.04.2 LTS",
    "os.version": input?.windows ? "10.0.26100" : "6.8.0",
    "os.arch": "x86_64",
    "shell.path": input?.windows
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : "/bin/zsh",
    "shell.name": input?.windows ? "powershell" : "zsh",
    "node.path": input?.windows ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
    "node.version": "v24.10.0",
    "npm.path": input?.windows ? "C:\\Program Files\\nodejs\\npm.cmd" : "/usr/bin/npm",
    "npm.version": "11.6.0",
    "pnpm.path": "",
    "pnpm.version": "",
    "yarn.path": "",
    "yarn.version": "",
    "bun.path": "",
    "bun.version": "",
    "starcode.path": "/home/operator/.local/bin/starcode",
    "starcode.version": "0.0.28",
    "service.supported": input?.windows ? "false" : "true",
    "service.installed": input?.windows ? "false" : "true",
    "service.state": input?.windows ? "unsupported" : "active",
    "port.status": "occupied",
    "port.owner": "node",
    "tailscale.path": input?.windows
      ? "C:\\Program Files\\Tailscale\\tailscale.exe"
      : "/usr/bin/tailscale",
    "tailscale.version": "1.84.1",
    "tailscale.state": "Running",
    "tailscale.ipv4": "100.100.1.2",
    ...overrides,
  };
  return [
    "remote login banner",
    SSH_PREFLIGHT_PROTOCOL_HEADER,
    ...Object.entries(values).map(([key, value]) => `${key}\t${value}`),
    SSH_PREFLIGHT_PROTOCOL_FOOTER,
    "",
  ].join("\n");
}

describe("SSH remote preflight", () => {
  it.effect("parses OS, shell, runtime, install, service, port, and Tailscale facts", () =>
    Effect.gen(function* () {
      const report = yield* parseSshRemotePreflightOutput(output(), 3773);

      assert.deepEqual(report.connection, {
        reachability: "reachable",
        authentication: "authenticated",
      });
      assert.equal(report.system?.platform, "linux");
      assert.equal(report.system?.shell.path, "/bin/zsh");
      assert.deepEqual(report.node, {
        availability: "available",
        path: "/usr/bin/node",
        version: "v24.10.0",
      });
      assert.deepEqual(report.packageManagers, [
        {
          name: "npm",
          availability: "available",
          path: "/usr/bin/npm",
          version: "11.6.0",
        },
      ]);
      assert.equal(report.starcode.service.status, "running");
      assert.equal(report.port.status, "occupied");
      assert.equal(report.tailscale.backendState, "Running");
      assert.deepEqual(report.tailscale.tailnetIpv4Addresses, ["100.100.1.2"]);
      assert.deepEqual(report.diagnostics, []);
      assert.isTrue(report.readyForProvisioning);
    }),
  );

  it.effect("returns actionable categories for every missing prerequisite", () =>
    Effect.gen(function* () {
      const report = yield* parseSshRemotePreflightOutput(
        output({
          "node.path": "",
          "node.version": "",
          "npm.path": "",
          "npm.version": "",
          "starcode.path": "",
          "starcode.version": "",
          "service.installed": "false",
          "service.state": "not-installed",
          "port.status": "occupied",
          "port.owner": "python",
          "tailscale.path": "",
          "tailscale.version": "",
          "tailscale.state": "",
          "tailscale.ipv4": "",
        }),
        3773,
      );

      assert.deepEqual(
        report.diagnostics.map((diagnostic) => diagnostic.category),
        [
          "node-missing",
          "package-manager-missing",
          "starcode-not-installed",
          "port-occupied",
          "tailscale-missing",
        ],
      );
      assert.isTrue(report.diagnostics.every((diagnostic) => diagnostic.action.length > 0));
      assert.isFalse(report.readyForProvisioning);
    }),
  );

  it.effect("diagnoses outdated Node, stopped StarCode, and inactive Tailscale", () =>
    Effect.gen(function* () {
      const report = yield* parseSshRemotePreflightOutput(
        output({
          "node.version": "v20.18.0",
          "service.state": "inactive",
          "port.status": "available",
          "port.owner": "",
          "tailscale.state": "Stopped",
        }),
      );

      assert.deepEqual(
        report.diagnostics.map((diagnostic) => diagnostic.category),
        ["node-version-unsupported", "starcode-service-stopped", "tailscale-not-running"],
      );
      assert.isFalse(report.readyForProvisioning);
    }),
  );

  it.effect("classifies rejected credentials without exposing raw SSH output", () => {
    const runner: SshPreflightCommandRunner = () =>
      Effect.fail(
        new SshCommandError({
          message: "Permission denied (publickey,password).",
          command: ["ssh"],
          exitCode: 255,
          stderr: "Permission denied (publickey,password). secret-sentinel",
        }),
      );
    return Effect.gen(function* () {
      const report = yield* runSshRemotePreflightWith(target, {}, runner);

      assert.deepEqual(report.connection, {
        reachability: "reachable",
        authentication: "rejected",
      });
      assert.equal(report.diagnostics[0]?.category, "authentication-failed");
      assert.notInclude(JSON.stringify(report), "secret-sentinel");
    });
  });

  it.effect("classifies an unreachable SSH endpoint separately from authentication", () => {
    const runner: SshPreflightCommandRunner = () =>
      Effect.fail(
        new SshCommandError({
          message: "ssh: connect to host remote.example.com port 22: Connection refused",
          command: ["ssh"],
          exitCode: 255,
          stderr: "ssh: connect to host remote.example.com port 22: Connection refused",
        }),
      );
    return Effect.gen(function* () {
      const report = yield* runSshRemotePreflightWith(target, {}, runner);

      assert.deepEqual(report.connection, {
        reachability: "unreachable",
        authentication: "unknown",
      });
      assert.equal(report.diagnostics[0]?.category, "host-unreachable");
    });
  });

  it.effect("falls back to PowerShell after an authenticated host has no sh", () => {
    const invocations: RunSshCommandOptions[] = [];
    const runner: SshPreflightCommandRunner = (_target, options) => {
      invocations.push(options);
      return invocations.length === 1
        ? Effect.fail(
            new SshCommandError({
              message: "sh: command not found",
              command: ["ssh"],
              exitCode: 127,
              stderr: "sh: command not found",
            }),
          )
        : Effect.succeed({ stdout: output({}, { windows: true }), stderr: "" });
    };
    return Effect.gen(function* () {
      const report = yield* runSshRemotePreflightWith(target, { port: 4555 }, runner);

      assert.equal(report.system?.platform, "windows");
      assert.deepEqual(invocations[0]?.remoteCommandArgs, ["sh", "-s", "--", "4555"]);
      assert.deepEqual(invocations[1]?.remoteCommandArgs, [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "-",
      ]);
      assert.include(invocations[1]?.stdin ?? "", "LocalPort 4555");
      assert.include(buildWindowsRemotePreflightScript(4555), "LocalPort 4555");
    });
  });

  it.effect("reports authenticated but unsupported shells when both probes fail", () => {
    const runner: SshPreflightCommandRunner = (_target, options) =>
      Effect.fail(
        new SshCommandError({
          message:
            options.remoteCommandArgs?.[0] === "sh" ? "sh: not found" : "powershell: not found",
          command: ["ssh"],
          exitCode: 127,
          stderr: "",
        }),
      );
    return Effect.gen(function* () {
      const report = yield* runSshRemotePreflightWith(target, {}, runner);

      assert.deepEqual(report.connection, {
        reachability: "reachable",
        authentication: "authenticated",
      });
      assert.equal(report.diagnostics[0]?.category, "remote-shell-unsupported");
    });
  });

  it.effect("reports invalid probe output after successful SSH authentication", () => {
    const runner: SshPreflightCommandRunner = () =>
      Effect.succeed({ stdout: "login succeeded but shell startup exited", stderr: "" });
    return Effect.gen(function* () {
      const report = yield* runSshRemotePreflightWith(target, {}, runner);

      assert.deepEqual(report.connection, {
        reachability: "reachable",
        authentication: "authenticated",
      });
      assert.equal(report.diagnostics[0]?.category, "probe-output-invalid");
    });
  });
});
