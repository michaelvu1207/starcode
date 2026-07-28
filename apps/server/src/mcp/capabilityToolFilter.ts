/**
 * Hides capability-gated tools from `tools/list`.
 *
 * The call-path guard in each toolkit is the security boundary and stays where
 * it is; this is purely about what a session is *shown*. Listing a tool an
 * agent can never successfully call is not a neutral cost — the agent reads the
 * list, believes it, tries the tool, and spends a turn discovering a refusal.
 * Every worker session paying that once is exactly the structural noise the
 * gating exists to avoid.
 *
 * Filtering happens on the response rather than at registration because
 * `McpServer.toolkit(...)` registers globally and Effect's own per-client
 * filter (`EnabledWhen`) only receives the MCP client's `initialize` payload —
 * the adapter's name and version, identical for every session on the machine.
 * It cannot see which t3 thread the bearer belongs to, which is the only thing
 * that decides this. So the seam has to be somewhere the resolved invocation is
 * in hand, and the auth middleware is the first such place.
 *
 * Fail-open by construction: anything this module does not positively
 * recognise as a JSON `tools/list` result is passed through untouched. A body
 * it cannot parse is a body it must not corrupt, and the guard behind the tool
 * still refuses the call.
 *
 * @module McpCapabilityToolFilter
 */
import * as Effect from "effect/Effect";
import { HttpBody, HttpServerResponse } from "effect/unstable/http";

import type * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * Tools that require a capability beyond the universal set, and the capability
 * each one needs. Declared here rather than inline so the list a session is
 * shown and the list its handlers enforce cannot drift apart.
 *
 * Note what is deliberately absent: `peer_thread_send`. Reaching a thread that
 * already exists is available to every session by design, so hiding it would
 * remove the one federation write ordinary agents are meant to have — and it is
 * the only one they need, now that it delivers rather than queues. What stays
 * gated is creating a thread that did not exist, which is the write no worker
 * has a reason to make on another machine.
 *
 * `project_file_thread` is absent for the same reason, and it is the clearest
 * case of why this list is about *visibility* rather than about writes: the
 * tool is usable by every session for the caller's own thread and gated only
 * for somebody else's, so the gate is a branch inside the handler and cannot be
 * expressed as "hide it". Listing it here would take self-filing away from
 * every worker to gate a use most of them will never reach for.
 *
 * `thread_create` is absent, and it is the deliberate one — it creates a thread
 * and spends a turn, which is the whole argument `peer_thread_create` rests on.
 * It loses to what gating it would cost: a worker that cannot start a helper on
 * its own machine is amputated exactly the way one that could not leave a
 * mailbox message would be, and that is the same trade `peer_thread_send` was
 * already decided on. The runaway risk master-only was implicitly covering is
 * answered where it belongs — a per-turn creation cap in `LocalThreadWriter` —
 * rather than by taking the tool away from everyone who is not the master.
 * Note this is also why it is a separate tool from `peer_thread_create` rather
 * than a `peer?` on it: this list keys on tool *name*, so one name cannot be
 * hidden from workers and shown to them at once.
 *
 * `project_set_icon` is absent on the same grounds, and it is the one that had
 * a real case against it: an icon is *display*, so it travels to every machine
 * rather than staying where it was written, and that is an argument for
 * master-only. It loses to the same branch the two above rest on — a thread
 * setting the icon of the project it is working in is doing its own
 * housekeeping, and the handler can simply refuse any other project.
 */
export const CAPABILITY_GATED_TOOLS: ReadonlyMap<string, McpInvocationContext.McpCapability> =
  new Map([
    ["peer_thread_create", "peers-operate"],
    // Same split on the feature map: reading it helps every agent orient,
    // writing it is the orchestrator's alone. `feature_map_list` is absent for
    // exactly the reason `peer_thread_send` is.
    ["feature_create", "features-operate"],
    ["feature_update", "features-operate"],
    ["feature_promote", "features-operate"],
    ["feature_link", "features-operate"],
    ["feature_plan_set", "features-operate"],
  ]);

interface ToolsListShape {
  readonly result: { readonly tools: ReadonlyArray<{ readonly name?: unknown }> };
}

/** Narrow to a JSON-RPC response actually carrying a tool list. */
const isToolsListPayload = (payload: unknown): payload is ToolsListShape => {
  if (typeof payload !== "object" || payload === null) return false;
  const result = (payload as { readonly result?: unknown }).result;
  if (typeof result !== "object" || result === null) return false;
  return Array.isArray((result as { readonly tools?: unknown }).tools);
};

export const isToolVisible = (
  toolName: unknown,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): boolean => {
  if (typeof toolName !== "string") return true;
  const required = CAPABILITY_GATED_TOOLS.get(toolName);
  return required === undefined || capabilities.has(required);
};

/**
 * Returns the payload with hidden tools removed, or `null` when nothing would
 * change. `null` rather than an equal copy so the caller can leave the original
 * response object — and its headers — completely alone in the common case.
 */
export const filterToolsListPayload = (
  payload: unknown,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): unknown | null => {
  if (!isToolsListPayload(payload)) return null;
  const tools = payload.result.tools;
  const visible = tools.filter((tool) => isToolVisible(tool?.name, capabilities));
  if (visible.length === tools.length) return null;
  return { ...payload, result: { ...payload.result, tools: visible } };
};

/** Bodies we can safely read and rewrite. A stream is neither. */
const readableBody = (response: HttpServerResponse.HttpServerResponse): string | null => {
  const body = response.body;
  if (body._tag !== "Uint8Array" && body._tag !== "Raw") return null;
  if (body.contentType?.includes("json") !== true) return null;
  if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body);
  return typeof body.body === "string" ? body.body : null;
};

/**
 * A body we cannot parse is one we must not corrupt, so failure and the JSON
 * value `null` collapse to the same thing: not a tool list, pass it through.
 */
const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const jsonBody = (payload: unknown) => HttpBody.text(JSON.stringify(payload), "application/json");

export const applyCapabilityToolFilter = (
  response: HttpServerResponse.HttpServerResponse,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.sync(() => {
    const text = readableBody(response);
    if (text === null) return response;
    const filtered = filterToolsListPayload(parseBody(text), capabilities);
    if (filtered === null) return response;
    // `setBody` carries status and headers across, which matters: the MCP
    // session id rides on this response.
    return HttpServerResponse.setBody(response, jsonBody(filtered));
  });
