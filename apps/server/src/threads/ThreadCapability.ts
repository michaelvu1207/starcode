/**
 * One policy for thread operations across protocol bindings.
 *
 * Bindings still translate a refusal into their own wire error, but none of
 * them re-decides who may list, read, send, or create.
 *
 * @module ThreadCapability
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@starcode/contracts";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

export type ThreadOperation = "list" | "read" | "send" | "create" | "turn" | "archive";

export type ThreadPrincipal =
  | {
      readonly kind: "mcp";
      readonly capabilities: ReadonlySet<McpInvocationContext.McpCapability>;
    }
  | {
      readonly kind: "environment";
      readonly scopes: ReadonlySet<AuthEnvironmentScope>;
    };

export interface ThreadAuthorizationRequest {
  readonly operation: ThreadOperation;
  /** Creating on another node spends a different machine's resources. */
  readonly remote?: boolean | undefined;
}

export const permitsThreadOperation = (
  principal: ThreadPrincipal,
  request: ThreadAuthorizationRequest,
): boolean => {
  if (principal.kind === "environment") {
    return principal.scopes.has(
      request.operation === "list" || request.operation === "read"
        ? AuthOrchestrationReadScope
        : AuthOrchestrationOperateScope,
    );
  }
  if (!principal.capabilities.has("threads")) return false;
  return request.operation !== "create" || request.remote !== true
    ? true
    : principal.capabilities.has("threads-operate");
};
