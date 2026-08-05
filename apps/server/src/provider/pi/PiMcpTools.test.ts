// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - focused HTTP boundary test.
import * as NodeHttp from "node:http";
import * as NodeTimers from "node:timers";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@starcode/contracts";
import { assert, describe, expect, it } from "@effect/vitest";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import { createPiMcpTools, piMcpToolName } from "./PiMcpTools.ts";

interface JsonRpcRequest {
  readonly method: string;
  readonly params?: unknown;
}

function configForPort(port: number): McpProviderSessionConfig {
  return {
    environmentId: EnvironmentId.make("environment-pi-mcp-test"),
    threadId: ThreadId.make("thread-pi-mcp-test"),
    providerSessionId: "provider-session-pi-mcp-test",
    providerInstanceId: ProviderInstanceId.make("pi-test"),
    endpoint: `http://127.0.0.1:${port}/mcp`,
    authorizationHeader: "Bearer pi-mcp-test-token",
  };
}

async function listen(server: NodeHttp.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an HTTP test port.");
  return address.port;
}

async function close(server: NodeHttp.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

const taskToolDescriptors = [
  {
    name: "thread_create",
    description: "create",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, message: { type: "string" } },
      required: ["title", "message"],
    },
  },
  {
    name: "thread_read",
    description: "read",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
  },
  {
    name: "threads_list",
    description: "list",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "thread_send",
    description: "send",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" }, message: { type: "string" } },
      required: ["threadId", "message"],
    },
  },
  {
    name: "peer_thread_create",
    description: "compatibility alias",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

async function withMcpServer<T>(
  respond: (request: JsonRpcRequest) => unknown,
  run: (config: McpProviderSessionConfig, requests: JsonRpcRequest[]) => Promise<T>,
): Promise<T> {
  const requests: JsonRpcRequest[] = [];
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest & {
        readonly id: number;
      };
      requests.push(decoded);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "pi-mcp-test-session");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: decoded.id, result: respond(decoded) }));
    });
  });
  const port = await listen(server);
  try {
    return await run(configForPort(port), requests);
  } finally {
    await close(server);
  }
}

describe("Pi Starcode task tools", () => {
  it("keeps separate top-level task creation distinct from attached-agent spawn", () => {
    assert.strictEqual(piMcpToolName("thread_create"), "starcode_new_task");
    assert.notStrictEqual(piMcpToolName("thread_create"), "starcode_spawn_agent");
    assert.strictEqual(piMcpToolName("thread_send"), "starcode_send_task_message");
  });

  it("registers and calls create/read/wait from an HTTP MCP tool list", async () => {
    const readsByThread = new Map<string, number>();
    let listCount = 0;
    await withMcpServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} };
        }
        if (request.method === "tools/list") {
          listCount += 1;
          return {
            tools:
              listCount === 1
                ? taskToolDescriptors.filter((tool) => tool.name === "thread_read")
                : taskToolDescriptors,
          };
        }
        if (request.method !== "tools/call") throw new Error(`Unexpected ${request.method}`);
        const params = request.params as {
          readonly name: string;
          readonly arguments: Record<string, unknown>;
        };
        if (params.name === "thread_create") {
          return {
            structuredContent: {
              threadId: "created-task",
              title: params.arguments.title,
            },
          };
        }
        if (params.name !== "thread_read") throw new Error(`Unexpected call ${params.name}`);
        const threadId = String(params.arguments.threadId);
        const read = (readsByThread.get(threadId) ?? 0) + 1;
        readsByThread.set(threadId, read);
        return {
          structuredContent: {
            threadId,
            status: threadId === "waiting-task" && read === 1 ? "working" : "input",
            entries: [],
          },
        };
      },
      async (config, requests) => {
        const tools = await createPiMcpTools(config);
        const names = tools.map((tool) => tool.name);
        expect(names).toContain("starcode_new_task");
        expect(names).toContain("starcode_read_task");
        expect(names).toContain("starcode_wait_task");
        expect(names).toContain("starcode_list_tasks");
        expect(names).not.toContain("starcode_spawn_agent");
        expect(names).not.toContain("peer_thread_create");

        const create = tools.find((tool) => tool.name === "starcode_new_task");
        const read = tools.find((tool) => tool.name === "starcode_read_task");
        const wait = tools.find((tool) => tool.name === "starcode_wait_task");
        expect(create).toBeDefined();
        expect(read).toBeDefined();
        expect(wait).toBeDefined();

        const created = await create!.execute(
          "create-call",
          { title: "Independent task", message: "Do independent work" },
          undefined,
          undefined,
          undefined as never,
        );
        expect(created.content[0]).toMatchObject({
          type: "text",
          text: JSON.stringify({ threadId: "created-task", title: "Independent task" }),
        });

        const readResult = await read!.execute(
          "read-call",
          { threadId: "read-task" },
          undefined,
          undefined,
          undefined as never,
        );
        expect(readResult.content[0]).toMatchObject({ type: "text" });

        const waited = await wait!.execute(
          "wait-call",
          // Keep the semantic two-poll assertion independent of a loaded CI
          // worker spending more than 100ms between the HTTP response and the
          // local elapsed-time check.
          { threadId: "waiting-task", timeoutMs: 5_000, pollIntervalMs: 1 },
          undefined,
          undefined,
          undefined as never,
        );
        const waitContent = waited.content[0];
        expect(waitContent?.type).toBe("text");
        if (waitContent?.type !== "text") return;
        expect(JSON.parse(waitContent.text)).toMatchObject({
          outcome: "status",
          status: "input",
          polls: 2,
          task: { threadId: "waiting-task", status: "input" },
        });

        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "tools/list",
          "initialize",
          "tools/list",
          "tools/call",
          "tools/call",
          "tools/call",
          "tools/call",
        ]);
        expect(
          requests
            .filter((request) => request.method === "tools/call")
            .map((request) => (request.params as { readonly name: string }).name),
        ).toEqual(["thread_create", "thread_read", "thread_read", "thread_read"]);
      },
    );
  });

  it("fails startup instead of silently omitting required task tools", async () => {
    await withMcpServer(
      (request) =>
        request.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
          : { tools: taskToolDescriptors.filter((tool) => tool.name === "thread_read") },
      async (config) => {
        await expect(createPiMcpTools(config)).rejects.toThrow(
          "required task tools after 8 attempts",
        );
      },
    );
  });

  it("returns after the first SSE event without waiting for the stream to close", async () => {
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest & {
          readonly id: number;
        };
        const result =
          decoded.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
            : { tools: taskToolDescriptors };
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "pi-mcp-sse-test-session",
        });
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: decoded.id, result })}\n\n`);
        // MCP's streaming transport deliberately keeps this response open.
      });
    });
    const port = await listen(server);
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = NodeTimers.setTimeout(
        () => reject(new Error("SSE tool discovery did not return")),
        1_000,
      );
    });
    try {
      const tools = await Promise.race([createPiMcpTools(configForPort(port)), deadline]);
      expect(tools.map((tool) => tool.name)).toContain("starcode_new_task");
    } finally {
      if (deadlineTimer) NodeTimers.clearTimeout(deadlineTimer);
      await close(server);
    }
  });

  it("aborts MCP tool discovery while a request is unresponsive", async () => {
    const server = NodeHttp.createServer((_request, _response) => {
      // Accept the request without producing headers or a response body.
    });
    const port = await listen(server);
    const abort = new AbortController();
    const timeout = NodeTimers.setTimeout(
      () => abort.abort(new DOMException("cancelled", "AbortError")),
      20,
    );
    try {
      await expect(createPiMcpTools(configForPort(port), abort.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      NodeTimers.clearTimeout(timeout);
      await close(server);
    }
  });

  it("bounds working-task waits and honors cancellation", async () => {
    await withMcpServer(
      (request) => {
        if (request.method === "initialize") {
          return { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} };
        }
        if (request.method === "tools/list") return { tools: taskToolDescriptors };
        return { structuredContent: { threadId: "working-task", status: "working" } };
      },
      async (config) => {
        const wait = (await createPiMcpTools(config)).find(
          (tool) => tool.name === "starcode_wait_task",
        );
        expect(wait).toBeDefined();
        const timedOut = await wait!.execute(
          "timeout-call",
          { threadId: "working-task", timeoutMs: 5, pollIntervalMs: 1 },
          undefined,
          undefined,
          undefined as never,
        );
        const timeoutContent = timedOut.content[0];
        expect(timeoutContent?.type).toBe("text");
        if (timeoutContent?.type === "text") {
          expect(JSON.parse(timeoutContent.text)).toMatchObject({
            outcome: "timeout",
            status: "working",
          });
        }

        const abort = new AbortController();
        abort.abort(new DOMException("cancelled", "AbortError"));
        await expect(
          wait!.execute(
            "abort-call",
            { threadId: "working-task", timeoutMs: 100, pollIntervalMs: 1 },
            abort.signal,
            undefined,
            undefined as never,
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
      },
    );
  });
});
