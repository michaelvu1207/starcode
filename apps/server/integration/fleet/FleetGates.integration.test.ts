// @effect-diagnostics nodeBuiltinImport:off - real filesystem integration boundary
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  runG1ThreadServiceGate,
  runG2FleetRosterGate,
  runG3ClientUnificationGate,
} from "./FleetGateScenarios.ts";
import { RealFleetGateDriver } from "./RealFleetGateDriver.ts";

const realFleetEnabled = process.env.STARCODE_RUN_FLEET_INTEGRATION === "1";
const describeRealFleet = realFleetEnabled ? describe.sequential : describe.skip;

describeRealFleet("real three-node fleet gates", () => {
  it("passes G0 bootstrap/tool integrity and G1 through the public MCP thread tools", async () => {
    const driver = await RealFleetGateDriver.start();
    try {
      const tools = await driver.mcpTools();
      expect(tools).toHaveLength(40);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(40);
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "threads_list",
          "thread_read",
          "thread_send",
          "thread_create",
          "project_upsert",
          "project_bind_location",
          "project_location_create",
          "project_location_update",
          "project_location_remove",
        ]),
      );
      expect(
        tools.every(
          (tool) =>
            typeof tool.inputSchema === "object" &&
            tool.inputSchema !== null &&
            "type" in tool.inputSchema &&
            tool.inputSchema.type === "object",
        ),
      ).toBe(true);
      const bootstrap = await driver.bootstrapInstructions("alpha");
      expect(bootstrap).toContain("<starcode_fleet>");
      expect(bootstrap).toContain("Current thread: Fleet gate master (thread-master-alpha)");
      expect(bootstrap).toContain("Current node:");
      expect(bootstrap).toContain("threads_list");
      expect(bootstrap).toContain("thread_send");
      expect(bootstrap).toContain("full project-management access");
      expect(bootstrap).not.toMatch(/Bearer\s+\S+/u);

      expect(
        await runG1ThreadServiceGate(driver, {
          timeoutMilliseconds: 45_000,
          pollIntervalMilliseconds: 100,
        }),
      ).toEqual({ gate: "G1", assertions: 11 });
    } finally {
      await driver.dispose();
    }
  }, 600_000);

  it("manages a project and physical folder on another connection through MCP", async () => {
    const driver = await RealFleetGateDriver.start();
    try {
      await driver.pair("alpha", "beta");
      const slug = "remote-project-management-gate";
      const workspaceRoot = NodePath.join(
        driver.harness.nodes.beta.homeDir,
        "remote-project-management-workspace",
      );

      const logical = await driver.callMcpTool<{
        readonly node: string;
        readonly created: boolean;
      }>("project_upsert", {
        node: "beta",
        slug,
        display: { title: "Remote project management gate" },
      });
      expect(logical.node).toBe("beta");
      expect(logical.created).toBe(true);

      const physical = await driver.callMcpTool<{
        readonly projectId: string;
        readonly boundSlug: string | null;
      }>("project_location_create", {
        node: "beta",
        title: "Remote managed folder",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        bindSlug: slug,
        preferred: true,
      });
      expect(physical.boundSlug).toBe(slug);

      await driver.callMcpTool("project_location_update", {
        node: "beta",
        projectId: physical.projectId,
        title: "Remote managed folder renamed",
      });
      const locations = await driver.callMcpTool<{
        readonly locations: ReadonlyArray<{
          readonly projectId: string;
          readonly title: string;
          readonly boundSlug: string | null;
        }>;
      }>("project_locations", { node: "beta" });
      expect(locations.locations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            projectId: physical.projectId,
            title: "Remote managed folder renamed",
            boundSlug: slug,
          }),
        ]),
      );

      const removed = await driver.callMcpTool<{
        readonly removed: boolean;
        readonly workspaceDeleted: boolean;
      }>("project_location_remove", {
        node: "beta",
        projectId: physical.projectId,
        force: true,
      });
      expect(removed).toMatchObject({ removed: true, workspaceDeleted: false });
      await expect(NodeFSP.access(workspaceRoot)).resolves.toBeUndefined();
      await driver.callMcpTool("project_remove", { node: "beta", slug });
    } finally {
      await driver.dispose();
    }
  }, 600_000);

  it("passes G3 and then G2 with only alpha-beta and beta-gamma pairing", async () => {
    const driver = await RealFleetGateDriver.start();
    try {
      expect(
        await runG3ClientUnificationGate(driver, {
          timeoutMilliseconds: 20_000,
          pollIntervalMilliseconds: 100,
        }),
      ).toEqual({
        gate: "G3",
        assertions: 4,
      });
      expect(
        await runG2FleetRosterGate(driver, {
          timeoutMilliseconds: 20_000,
          pollIntervalMilliseconds: 100,
        }),
      ).toEqual({ gate: "G2", assertions: 7 });
    } finally {
      await driver.dispose();
    }
  }, 600_000);
});
