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
      expect(tools).toHaveLength(33);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(33);
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["threads_list", "thread_read", "thread_send", "thread_create"]),
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
