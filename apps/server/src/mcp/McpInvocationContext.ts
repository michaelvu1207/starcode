import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * `peers` is federation read plus mailbox send — everything an agent can do to
 * another thread without costing it a turn, granted to every session.
 *
 * `peers-operate` is the orchestrator's grant: create a thread on another
 * machine, and interrupt one. It is issued only to sessions of the thread named
 * by `workbenchMasterThreadId`, which is why gating lives at credential-mint
 * time rather than in the tool handlers alone — a session that is not the
 * master never holds a token that carries it.
 */
export type McpCapability = "preview" | "peers" | "peers-operate" | "features-operate";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

// Preview-specific: its failure type names the preview capability, so other
// capabilities carry their own guard rather than widening this error contract.
export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
