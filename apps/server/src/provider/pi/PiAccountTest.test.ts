// @effect-diagnostics nodeBuiltinImport:off instanceofSchema:off - isolated filesystem fixture and typed-error assertion.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PiAccountAuthError, ProviderInstanceId } from "@starcode/contracts";
import { assert, it } from "@effect/vitest";

import { testPiAccount } from "./PiAccountTest.ts";
import { refreshAllPiAccountUsage } from "./PiAccountAuthFlow.ts";

it("fails safely when a connection has no stored Pi credential", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-pi-test-"));
  try {
    let captured: unknown;
    try {
      await testPiAccount({
        instanceId: ProviderInstanceId.make("starcode_openai_missing"),
        stateDir: NodePath.join(root, "state"),
        secretsDir: NodePath.join(root, "secrets"),
      });
    } catch (error) {
      captured = error;
    }
    assert(captured instanceof PiAccountAuthError);
    assert.strictEqual(captured.reason, "not_found");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refreshes all discovered subscriptions without inventing usage", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-pi-usage-"));
  try {
    const outcomes = await refreshAllPiAccountUsage({
      stateDir: NodePath.join(root, "state"),
      secretsDir: NodePath.join(root, "secrets"),
    });
    assert.deepStrictEqual(outcomes, []);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
