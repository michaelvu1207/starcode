#!/usr/bin/env node
/* oxlint-disable starcode/no-global-process-runtime -- standalone subprocess protocol fixture */

import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

const appServerMode = process.argv.includes("app-server");
if (!appServerMode) {
  process.stdout.write("codex-cli 0.0.0-fleet-gate\n");
  process.exit(0);
}

const writeMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id, result) => {
  writeMessage({ id, result });
};

const respondError = (id, method) => {
  writeMessage({ id, error: { code: -32601, message: `Unhandled request: ${method}` } });
};

const mcpEndpointArgument = process.argv.find((argument) =>
  argument.startsWith("mcp_servers.starcode.url="),
);
const mcpEndpoint = mcpEndpointArgument?.slice("mcp_servers.starcode.url=".length);
const mcpToken = process.env.STARCODE_MCP_BEARER_TOKEN;
const captureSocket = process.env.STARCODE_FLEET_MCP_CAPTURE_SOCKET;
const bootstrapCapturePath = process.env.STARCODE_FLEET_BOOTSTRAP_CAPTURE_PATH;
const holdFirstTurnMarker = process.env.STARCODE_FLEET_HOLD_FIRST_TURN_MARKER;
let holdTurnsOpen = false;

if (mcpEndpoint && mcpToken && captureSocket) {
  if (holdFirstTurnMarker) {
    try {
      NodeFS.closeSync(NodeFS.openSync(holdFirstTurnMarker, "wx", 0o600));
      holdTurnsOpen = true;
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
    }
  }
  const capture = NodeNet.createConnection(captureSocket);
  capture.once("connect", () => {
    capture.end(`${JSON.stringify({ endpoint: mcpEndpoint, token: mcpToken })}\n`);
  });
  // A failed test-only capture must not kill the provider session or print the
  // credential through an uncaught socket error.
  capture.once("error", () => undefined);
}

let nextProviderThread = 0;
let nextTurn = 0;
let remainder = "";

const threadResponse = (params = {}) => {
  const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
  const model = typeof params.model === "string" ? params.model : "gpt-5-codex";
  const id = `provider-thread-${++nextProviderThread}`;
  const now = Math.floor(Date.now() / 1_000);
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd,
    model,
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id,
      cliVersion: "0.0.0-fleet-gate",
      createdAt: now,
      cwd,
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      sessionId: id,
      source: "cli",
      status: { type: "idle" },
      turns: [],
      updatedAt: now,
    },
  };
};

const handleMethod = (message) => {
  const method = message.method;
  if (typeof method !== "string") return;

  switch (method) {
    case "initialize": {
      const platform = NodeOS.platform();
      respond(message.id, {
        userAgent: "codex-fleet-gate/0.0.0",
        codexHome: process.cwd(),
        platformFamily: platform === "win32" ? "windows" : "unix",
        platformOs: platform === "darwin" ? "macos" : platform,
      });
      return;
    }
    case "initialized": {
      return;
    }
    case "account/read": {
      respond(message.id, {
        account: { type: "chatgpt", email: "fleet-gate@example.invalid", planType: "plus" },
        requiresOpenaiAuth: false,
      });
      return;
    }
    case "skills/list": {
      const cwds = Array.isArray(message.params?.cwds) ? message.params.cwds : [process.cwd()];
      respond(message.id, {
        data: cwds.map((cwd) => ({ cwd, errors: [], skills: [] })),
      });
      return;
    }
    case "model/list": {
      respond(message.id, {
        data: [
          {
            defaultReasoningEffort: "medium",
            description: "Fleet integration fixture model",
            displayName: "GPT-5 Codex",
            hidden: false,
            id: "gpt-5-codex",
            inputModalities: ["text"],
            isDefault: true,
            model: "gpt-5-codex",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Fixture reasoning effort" },
            ],
            supportsPersonality: false,
          },
        ],
        nextCursor: null,
      });
      return;
    }
    case "thread/start": {
      if (bootstrapCapturePath && typeof message.params?.developerInstructions === "string") {
        NodeFS.writeFileSync(bootstrapCapturePath, message.params.developerInstructions, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      respond(message.id, threadResponse(message.params));
      return;
    }
    case "thread/resume":
    case "thread/fork": {
      respond(message.id, threadResponse(message.params));
      return;
    }
    case "config/mcpServer/reload": {
      respond(message.id, {});
      return;
    }
    case "turn/start": {
      const turnId = `provider-turn-${++nextTurn}`;
      const threadId =
        typeof message.params?.threadId === "string"
          ? message.params.threadId
          : `provider-thread-${nextProviderThread}`;
      const turn = { id: turnId, items: [], status: "inProgress" };
      respond(message.id, { turn });
      writeMessage({ method: "turn/started", params: { threadId, turn } });
      if (holdTurnsOpen) return;
      queueMicrotask(() => {
        writeMessage({
          method: "turn/completed",
          params: {
            threadId,
            turn: { ...turn, status: "completed", completedAt: Math.floor(Date.now() / 1_000) },
          },
        });
      });
      return;
    }
    default: {
      if (message.id !== undefined) respondError(message.id, method);
    }
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const message = JSON.parse(trimmed);
    if ("method" in message) handleMethod(message);
  }
});

process.stdin.on("end", () => process.exit(0));
