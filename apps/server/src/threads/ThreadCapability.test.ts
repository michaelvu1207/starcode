import { expect, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@starcode/contracts";

import { permitsThreadOperation } from "./ThreadCapability.ts";

it("uses one per-session policy for MCP local and remote operations", () => {
  const worker = { kind: "mcp" as const, capabilities: new Set(["threads"] as const) };
  const master = {
    kind: "mcp" as const,
    capabilities: new Set(["threads", "threads-operate"] as const),
  };

  expect(permitsThreadOperation(worker, { operation: "read" })).toBe(true);
  expect(permitsThreadOperation(worker, { operation: "send" })).toBe(true);
  expect(permitsThreadOperation(worker, { operation: "create" })).toBe(true);
  expect(permitsThreadOperation(worker, { operation: "create", remote: true })).toBe(false);
  expect(permitsThreadOperation(master, { operation: "create", remote: true })).toBe(true);
});

it("maps authenticated environment scopes into the same policy", () => {
  const reader = {
    kind: "environment" as const,
    scopes: new Set([AuthOrchestrationReadScope]),
  };
  const operator = {
    kind: "environment" as const,
    scopes: new Set([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
  };

  expect(permitsThreadOperation(reader, { operation: "read" })).toBe(true);
  expect(permitsThreadOperation(reader, { operation: "send" })).toBe(false);
  expect(permitsThreadOperation(operator, { operation: "send" })).toBe(true);
});
