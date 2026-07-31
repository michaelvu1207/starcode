// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes } from "@starcode/contracts";
import * as NetService from "@starcode/shared/Net";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  DevServerNotProxiableError,
  resolveDirectPairingBaseUrl,
  resolveTailscaleLocalTarget,
} from "./pair.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const baseState = {
  version: 1,
  pid: 123,
  port: 3_773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-06-20T00:00:00.000Z",
} as const satisfies PersistedServerRuntimeState;

describe("pair base URL selection", () => {
  it("uses the dev web origin when present", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, devUrl: "http://localhost:5733/" })).toBe(
      "http://localhost:5733/",
    );
  });

  it("uses the reachable server host otherwise", () => {
    expect(resolveDirectPairingBaseUrl({ ...baseState, host: "100.64.0.7" })).toBe(
      "http://100.64.0.7:3773",
    );
    expect(resolveDirectPairingBaseUrl(baseState)).toBe("http://localhost:3773");
  });
});

describe("pair tailscale local target", () => {
  it("proxies the dev web port and preserves non-loopback hosts", () => {
    expect(resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://localhost:5733/" })).toEqual(
      { localPort: 5_733 },
    );
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "http://192.168.1.10:5733/" }),
    ).toEqual({ localPort: 5_733, localHost: "192.168.1.10" });
  });

  it("rejects HTTPS dev targets and maps ordinary server targets", () => {
    expect(
      resolveTailscaleLocalTarget({ ...baseState, devUrl: "https://localhost:5733/" }),
    ).toBeInstanceOf(DevServerNotProxiableError);
    expect(resolveTailscaleLocalTarget(baseState)).toEqual({ localPort: 3_773 });
    expect(resolveTailscaleLocalTarget({ ...baseState, host: "192.168.1.42" })).toEqual({
      localPort: 3_773,
      localHost: "192.168.1.42",
    });
  });
});

const runCli = (args: ReadonlyArray<string>) =>
  Effect.promise(() => import("../bin.ts")).pipe(
    Effect.flatMap(({ cli }) => Command.runWith(cli, { version: "0.0.0" })(args)),
  );
const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(CliRuntimeLayer, TestConsole.layer));
const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const testDescriptor = {
  environmentId: "pair-test-environment",
  label: "pair-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

const withDescriptorServer = <A, E, R>(run: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(testDescriptor));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("starcode pair", () => {
  it.effect("mints one unified administrative credential for a live server", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "starcode-pair-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));
        assert.include(output, `Pairing with pair-test (${origin})`);
        assert.include(output, `Pairing URL: ${origin}/pair#token=`);
        assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));

        const listed = yield* captureStdout(
          runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off - presentation DTO from CLI output.
        const credentials = JSON.parse(listed) as ReadonlyArray<{
          readonly label?: string;
          readonly scopes: ReadonlyArray<string>;
        }>;
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0]?.label, "starcode pair");
        assert.deepEqual(credentials[0]?.scopes, AuthAdministrativeScopes);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports the exact state paths checked when no server is live", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "starcode-pair-none-test-"),
      );
      const error = yield* provideCliTestLayers(
        runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
      );
      const rendered = String(
        typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
      );
      assert.include(rendered, "No running StarCode server found.");
      assert.include(rendered, "starcode serve");
      assert.include(rendered, "starcode connect");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
