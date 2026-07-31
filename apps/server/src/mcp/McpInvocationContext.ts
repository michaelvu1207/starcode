import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * `peers` is the ordinary agent's grant: read what other threads are doing, and
 * say something to one — whether it is on this machine or another. Every session
 * gets it. The name is about *other threads*, not about other machines, which is
 * why the local `thread_create` and `project_*` toolkits check it too: they are
 * all "may this session act on the thread graph at all", and there has never
 * been a session that should hold one of them without the rest.
 *
 * `threads-operate` is the orchestrator's grant, and it is the answer to a
 * different question: may this session spend another machine's resources, or
 * reach a machine outside the toolkit entirely. It covers creating a thread on a
 * peer and reading the SSH login out of `peers_list`. It is issued only to
 * sessions of a designated master thread, which is why the gating lives at
 * credential-mint time rather than in the tool handlers alone — a session that
 * is not a master never holds a token that carries it.
 */
export type McpCapability =
  | "preview"
  | "threads"
  | "threads-operate"
  /** @deprecated one-release compatibility grants; issuance-only, policy does not read them. */
  | "peers"
  | "peers-operate"
  | "features-operate";

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
>()("starcode/mcp/McpInvocationContext") {}

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
