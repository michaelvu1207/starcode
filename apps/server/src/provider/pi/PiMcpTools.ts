// @effect-diagnostics globalFetch:off globalDate:off globalTimers:off nodeBuiltinImport:off - Pi tools run outside Effect and use AbortSignal.
import * as NodeTimers from "node:timers";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";

interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

interface McpJsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

const EXCLUDED_COMPATIBILITY_TOOLS = new Set([
  "peer_thread_create",
  "peer_thread_read",
  "peer_thread_send",
  "peer_threads_list",
  "peers_list",
]);

const DISPLAY_NAME_BY_MCP_TOOL: Readonly<Record<string, string>> = {
  thread_create: "starcode_new_task",
  thread_read: "starcode_read_task",
  thread_send: "starcode_send_task_message",
  threads_list: "starcode_list_tasks",
};

const REQUIRED_TASK_MCP_TOOLS = [
  "thread_create",
  "thread_read",
  "thread_send",
  "threads_list",
] as const;
const WAIT_TASK_TERMINAL_STATUSES = new Set(["approval", "input", "failed", "archived", "idle"]);
const WAIT_TASK_DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_TASK_MAX_TIMEOUT_MS = 300_000;
const WAIT_TASK_DEFAULT_POLL_INTERVAL_MS = 1_000;
const WAIT_TASK_MAX_POLL_INTERVAL_MS = 30_000;
const REQUIRED_TOOL_DISCOVERY_ATTEMPTS = 8;
const REQUIRED_TOOL_DISCOVERY_DELAY_MS = 250;
const MCP_REQUEST_TIMEOUT_MS = 5_000;

export function piMcpToolName(mcpName: string): string {
  return DISPLAY_NAME_BY_MCP_TOOL[mcpName] ?? mcpName;
}

class PiMcpClient {
  private readonly config: McpProviderSessionConfig;
  private requestId = 0;
  private sessionId: string | undefined;
  private initialized = false;

  constructor(config: McpProviderSessionConfig) {
    this.config = config;
  }

  private async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const requestAbort = new AbortController();
    const onAbort = () =>
      requestAbort.abort(
        signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = NodeTimers.setTimeout(
      () =>
        requestAbort.abort(
          new DOMException(
            `Starcode MCP request timed out after ${MCP_REQUEST_TIMEOUT_MS}ms.`,
            "TimeoutError",
          ),
        ),
      MCP_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          authorization: this.config.authorizationHeader,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.requestId,
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: requestAbort.signal,
      });
      if (!response.ok) {
        throw new Error(`Starcode MCP request failed (${response.status}).`);
      }
      this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
      const contentType = response.headers.get("content-type") ?? "";
      const payloadText = contentType.includes("text/event-stream")
        ? await readFirstSseData(response)
        : await response.text();
      if (!payloadText) return undefined;
      const decoded = JSON.parse(payloadText) as McpJsonRpcResponse;
      if (decoded.error) {
        throw new Error(
          decoded.error.message ?? `Starcode MCP error ${decoded.error.code ?? "unknown"}.`,
        );
      }
      return decoded.result;
    } finally {
      NodeTimers.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "starcode-pi", version: "1" },
      },
      signal,
    );
    this.initialized = true;
  }

  async listTools(signal?: AbortSignal): Promise<ReadonlyArray<McpToolDescriptor>> {
    await this.initialize(signal);
    const result = (await this.request("tools/list", {}, signal)) as
      | { readonly tools?: ReadonlyArray<McpToolDescriptor> }
      | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.initialize(signal);
    return this.request("tools/call", { name, arguments: args }, signal);
  }
}

async function readFirstSseData(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let boundary = /\r?\n\r?\n/.exec(buffered);
      while (boundary) {
        const event = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n")
          .trim();
        if (data) return data;
        boundary = /\r?\n\r?\n/.exec(buffered);
      }
      if (done) {
        const data = buffered
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n")
          .trim();
        return data || undefined;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result ?? null);
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) return JSON.stringify(record.structuredContent);
  if (Array.isArray(record.content)) {
    const texts = record.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    });
    if (texts.length > 0) return texts.join("\n");
  }
  return JSON.stringify(result);
}

function structuredResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) return record.structuredContent;
  if (!Array.isArray(record.content)) return undefined;
  const text = record.content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function taskStatus(result: unknown): string | undefined {
  const structured = structuredResult(result);
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    return undefined;
  }
  const status = (structured as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = NodeTimers.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      NodeTimers.clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function piTaskWaitTool(client: PiMcpClient): ToolDefinition {
  return defineTool({
    name: "starcode_wait_task",
    label: "Wait for top-level task",
    description:
      "Wait for a separate top-level Starcode task while it is working. Returns immediately when it becomes idle, fails, is archived, or needs approval/input. The wait is bounded and does not address same-task AgentRuns.",
    parameters: Type.Object({
      threadId: Type.String({ description: "Top-level Starcode task/thread ID." }),
      timeoutMs: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: WAIT_TASK_MAX_TIMEOUT_MS,
          description: `Maximum wait in milliseconds. Defaults to ${WAIT_TASK_DEFAULT_TIMEOUT_MS}.`,
        }),
      ),
      pollIntervalMs: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: WAIT_TASK_MAX_POLL_INTERVAL_MS,
          description: `Delay between reads in milliseconds. Defaults to ${WAIT_TASK_DEFAULT_POLL_INTERVAL_MS}.`,
        }),
      ),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      const startedAt = Date.now();
      const timeoutMs = params.timeoutMs ?? WAIT_TASK_DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? WAIT_TASK_DEFAULT_POLL_INTERVAL_MS;
      let polls = 0;
      while (true) {
        signal?.throwIfAborted();
        const result = await client.callTool("thread_read", { threadId: params.threadId }, signal);
        polls += 1;
        const status = taskStatus(result);
        if (status === undefined) {
          throw new Error("Starcode thread_read returned no recognizable task status.");
        }
        const elapsedMs = Date.now() - startedAt;
        const outcome = WAIT_TASK_TERMINAL_STATUSES.has(status)
          ? "status"
          : elapsedMs >= timeoutMs
            ? "timeout"
            : undefined;
        if (outcome) {
          const value = {
            outcome,
            status,
            elapsedMs,
            polls,
            task: structuredResult(result),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            details: { mcpTool: "thread_read", result, wait: value },
          };
        }
        await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs), signal);
      }
    },
  });
}

export async function createPiMcpTools(
  config: McpProviderSessionConfig | undefined,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ToolDefinition>> {
  if (!config) return [];
  let discovered:
    | {
        readonly client: PiMcpClient;
        readonly tools: ReadonlyArray<McpToolDescriptor>;
        readonly toolNames: ReadonlySet<string>;
      }
    | undefined;
  let discoveryError: unknown;
  for (let attempt = 1; attempt <= REQUIRED_TOOL_DISCOVERY_ATTEMPTS; attempt += 1) {
    // A startup retry needs a fresh MCP protocol session. Reusing a client can
    // carry a pre-restart session id into the now-ready HTTP listener.
    const candidate = new PiMcpClient(config);
    try {
      const tools = await candidate.listTools(signal);
      const toolNames = new Set(tools.map((tool) => tool.name));
      const missing = REQUIRED_TASK_MCP_TOOLS.filter((name) => !toolNames.has(name));
      if (missing.length === 0) {
        discovered = { client: candidate, tools, toolNames };
        break;
      }
      discoveryError = new Error(
        `Starcode MCP did not expose required Pi task tools: ${missing.join(", ")}.`,
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      discoveryError = error;
    }
    if (attempt < REQUIRED_TOOL_DISCOVERY_ATTEMPTS) {
      await sleep(REQUIRED_TOOL_DISCOVERY_DELAY_MS, signal);
    }
  }
  if (!discovered) {
    const detail =
      discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
    throw new Error(
      `Pi could not acquire Starcode's required task tools after ${REQUIRED_TOOL_DISCOVERY_ATTEMPTS} attempts. ${detail}`,
      { cause: discoveryError },
    );
  }
  const { client, tools, toolNames } = discovered;
  const exposed: ToolDefinition[] = tools
    .filter((tool) => !EXCLUDED_COMPATIBILITY_TOOLS.has(tool.name))
    .map((tool) => {
      const exposedName = piMcpToolName(tool.name);
      const description =
        tool.name === "thread_create"
          ? "Create a genuinely separate top-level Starcode task. It appears independently in the task list and is not a same-task subagent."
          : (tool.description ?? `Call Starcode's ${tool.name} capability.`);
      return defineTool({
        name: exposedName,
        label: exposedName,
        description,
        parameters: tool.inputSchema as unknown as TSchema,
        executionMode: "parallel",
        execute: async (_toolCallId, params, signal) => {
          const result = await client.callTool(tool.name, params, signal);
          return {
            content: [{ type: "text", text: resultText(result) }],
            details: { mcpTool: tool.name, result },
          };
        },
      });
    });
  if (toolNames.has("thread_read")) exposed.push(piTaskWaitTool(client));
  return exposed;
}
