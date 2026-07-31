// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem lifecycle integration
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  FLEET_HARNESS_NODE_NAMES,
  FleetHarnessLifecycleError,
  ThreeNodeFleetHarness,
  type FleetHarnessNode,
  type FleetHarnessProcess,
} from "./ThreeNodeFleetHarness.ts";

const fixedPorts = {
  alpha: 43_101,
  beta: 43_102,
  gamma: 43_103,
} as const;

const makeFakeProcess = (node: FleetHarnessNode, stopped: Array<string>): FleetHarnessProcess => ({
  pid: node.port,
  exited: new Promise(() => undefined),
  stop: async () => {
    stopped.push(node.name);
  },
});

describe("ThreeNodeFleetHarness", () => {
  it("constructs isolated nodes, starts them in order, and preserves homes across restart", async () => {
    const rootDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "starcode-fleet-harness-test-"),
    );
    const launched: Array<FleetHarnessNode> = [];
    const readied: Array<string> = [];
    const stopped: Array<string> = [];
    const harness = await ThreeNodeFleetHarness.make({
      rootDir,
      ports: fixedPorts,
      launchNode: async (node) => {
        launched.push(node);
        return makeFakeProcess(node, stopped);
      },
      waitForReady: async (node) => {
        readied.push(node.name);
      },
    });

    try {
      expect(harness.nodes.alpha.baseUrl).toBe("http://127.0.0.1:43101");
      expect(harness.nodes.beta.homeDir).toBe(NodePath.join(rootDir, "beta"));
      expect(new Set(Object.values(harness.nodes).map((node) => node.homeDir)).size).toBe(3);

      await harness.start();
      expect(launched.map((node) => node.name)).toEqual(FLEET_HARNESS_NODE_NAMES);
      expect(readied).toEqual(FLEET_HARNESS_NODE_NAMES);
      expect(harness.runningNodes).toEqual(FLEET_HARNESS_NODE_NAMES);

      const gammaHome = harness.nodes.gamma.homeDir;
      await harness.restartNode("gamma");
      expect(stopped).toEqual(["gamma"]);
      expect(launched.at(-1)?.homeDir).toBe(gammaHome);
      expect(harness.runningNodes).toEqual(FLEET_HARNESS_NODE_NAMES);
    } finally {
      await harness.dispose();
      await NodeFSP.rm(rootDir, { recursive: true, force: true });
    }

    expect(stopped).toEqual(["gamma", "gamma", "beta", "alpha"]);
  });

  it("rolls back every started process when readiness fails", async () => {
    const launched: Array<string> = [];
    const stopped: Array<string> = [];
    const harness = await ThreeNodeFleetHarness.make({
      ports: fixedPorts,
      launchNode: async (node) => {
        launched.push(node.name);
        return makeFakeProcess(node, stopped);
      },
      waitForReady: async (node) => {
        if (node.name === "beta") throw new Error("not ready");
      },
    });

    await expect(harness.start()).rejects.toMatchObject({
      name: "FleetHarnessLifecycleError",
      node: "beta",
      operation: "ready",
    } satisfies Partial<FleetHarnessLifecycleError>);
    expect(launched).toEqual(["alpha", "beta"]);
    // Beta is stopped by its failed readiness path; alpha by start rollback.
    expect(stopped).toEqual(["beta", "alpha"]);
    expect(harness.runningNodes).toEqual([]);
    await harness.dispose();
  });

  it("owns and removes an implicit temporary root", async () => {
    const stopped: Array<string> = [];
    const harness = await ThreeNodeFleetHarness.make({
      ports: fixedPorts,
      launchNode: async (node) => makeFakeProcess(node, stopped),
      waitForReady: async () => undefined,
    });
    const rootDir = harness.rootDir;
    expect(await NodeFSP.stat(rootDir)).toBeDefined();

    await harness.dispose();
    await expect(NodeFSP.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate fixed ports before launching anything", async () => {
    await expect(
      ThreeNodeFleetHarness.make({
        ports: { alpha: 43_101, beta: 43_101, gamma: 43_103 },
      }),
    ).rejects.toThrow("three distinct TCP port numbers");
  });
});
