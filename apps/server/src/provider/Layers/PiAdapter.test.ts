// @effect-diagnostics nodeBuiltinImport:off globalDate:off - real Pi session integration fixture.
// These integration fixtures cross Pi's Promise/callback API boundary and manage
// their own adapter lifetime explicitly instead of using an Effect test Layer.
/* oxlint-disable starcode/no-manual-effect-runtime-in-tests */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  ApprovalRequestId,
  EnvironmentId,
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@starcode/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { setAttachedAgentHost } from "../AttachedAgentHost.ts";
import type { FleetSessionBootstrapSnapshotProvider } from "../FleetSessionBootstrap.ts";
import { makePiAdapter, repairInterruptedToolCallReplay } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("repairInterruptedToolCallReplay", () => {
  it("keeps an interrupted persisted tool call replayable without reviving empty errors", () => {
    const call = fauxToolCall("bash", { command: "printf interrupted" });
    const interrupted = fauxAssistantMessage(call, {
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    });
    const emptyError = fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "transport failed",
    });

    const repaired = repairInterruptedToolCallReplay([interrupted, emptyError]);

    expect(repaired[0]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
    expect(repaired[0]).not.toHaveProperty("errorMessage");
    expect(repaired[1]).toBe(emptyError);
  });
});

async function fixture(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  onSession?: (session: AgentSession, customToolNames: ReadonlyArray<string>) => void,
  stopGraceMs?: number,
  allowMissingMcpForTests = true,
  forceReasoningModel = false,
  enabledModels: ReadonlyArray<string> = ["starcode-faux/*"],
  fleetSessionBootstrapSnapshot?: FleetSessionBootstrapSnapshotProvider,
) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "starcode-pi-adapter-"));
  const faux = fauxProvider({ provider: "starcode-faux", tokensPerSecond: 0 });
  faux.setResponses(responses);
  if (forceReasoningModel) {
    const target = faux.models[0]!;
    Object.assign(target, { reasoning: true });
  }
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("starcode-faux", "test-key", { allowNetwork: false });
  const registry = new ModelRegistry(modelRuntime);
  const adapter = await Effect.runPromise(
    makePiAdapter({
      instanceId: ProviderInstanceId.make("pi-test"),
      config: decodePiSettings({ enabledModels }),
      agentDir: NodePath.join(directory, "agent"),
      attachmentsDir: NodePath.join(directory, "attachments"),
      modelRegistry: registry,
      modelRuntime,
      ...(fleetSessionBootstrapSnapshot ? { fleetSessionBootstrapSnapshot } : {}),
      allowMissingMcpForTests,
      ...(stopGraceMs !== undefined ? { stopGraceMs } : {}),
      ...(onSession
        ? {
            createSession: async (options) => {
              const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
              const created = await createAgentSession(options);
              onSession(created.session, options?.customTools?.map((tool) => tool.name) ?? []);
              return created;
            },
          }
        : {}),
    }),
  );
  return {
    directory,
    faux,
    registry,
    modelRuntime,
    adapter,
    cleanup: async () => {
      await Effect.runPromise(adapter.stopAll());
      setAttachedAgentHost(undefined);
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function withPiMcpDescriptorServer<T>(run: (endpoint: string) => Promise<T>): Promise<T> {
  const descriptors = [
    {
      name: "thread_create",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "thread_read",
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string" } },
        required: ["threadId"],
      },
    },
    {
      name: "thread_send",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          message: { type: "string" },
        },
        required: ["threadId", "message"],
      },
    },
    {
      name: "threads_list",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  let toolLists = 0;
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly id: number;
        readonly method: string;
      };
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "pi-adapter-mcp-test");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: (() => {
            if (body.method === "initialize") {
              return { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} };
            }
            toolLists += 1;
            return { tools: toolLists === 1 ? descriptors.slice(1) : descriptors };
          })(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an HTTP test port.");
  try {
    return await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function collectThrough(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
) {
  return Array.from(
    await Effect.runPromise(Stream.runCollect(Stream.takeUntil(stream, predicate))),
  );
}

describe("PiAdapter canonical lifecycle", () => {
  it("appends current fleet, thread, and project bootstrap to Pi's system prompt", async () => {
    const threadId = ThreadId.make("pi-fleet-bootstrap");
    let systemPrompt = "";
    const test = await fixture(
      [],
      (session) => {
        systemPrompt = session.systemPrompt;
      },
      undefined,
      true,
      false,
      ["starcode-faux/*"],
      () =>
        Effect.succeed({
          localNode: {
            environmentId: EnvironmentId.make("alpha-node"),
            label: "Alpha Mac",
          },
          reachableNodes: [
            {
              environmentId: EnvironmentId.make("worker-node"),
              label: "Worker Linux",
            },
          ],
          thread: { threadId, title: "Native Pi cutover" },
          project: { slug: "starcode", title: "Starcode", notes: "Use Pi exclusively." },
          orchestrator: { role: "project" },
        }),
    );
    try {
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );

      expect(systemPrompt).toContain("You are Starcode's native Pi coding agent.");
      expect(systemPrompt).toContain("<starcode_fleet>");
      expect(systemPrompt).toContain("Current thread: Native Pi cutover (pi-fleet-bootstrap)");
      expect(systemPrompt).toContain("Current node: Alpha Mac (alpha-node)");
      expect(systemPrompt).toContain("Current project: Starcode (starcode)");
      expect(systemPrompt).toContain("project-management access");
    } finally {
      await test.cleanup();
    }
  });

  it.each([
    ["openai-codex", "gpt-5.6-sol"],
    ["anthropic", "claude-opus-5"],
    ["anthropic", "claude-fable-5"],
  ])(
    "launches exact %s/%s selection with high Pi thinking and explicit 600k context",
    async (provider, modelId) => {
      let createdSession: AgentSession | undefined;
      const test = await fixture(
        [fauxAssistantMessage("high effort complete")],
        (session) => {
          createdSession = session;
        },
        undefined,
        true,
        true,
        [`${provider}/${modelId}`],
      );
      try {
        const threadId = ThreadId.make(`pi-high-effort-${modelId}`);
        const targetFaux = fauxProvider({
          provider,
          tokensPerSecond: 0,
          models: [{ id: modelId, reasoning: true, contextWindow: 1_000_000 }],
        });
        targetFaux.setResponses([fauxAssistantMessage("high effort complete")]);
        test.modelRuntime.registerNativeProvider(targetFaux.provider);
        await test.modelRuntime.setRuntimeApiKey(provider, "test-key", { allowNetwork: false });
        const session = await Effect.runPromise(
          test.adapter.startSession({
            threadId,
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: `${provider}/${modelId}`,
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "context", value: "600k" },
              ],
            },
          }),
        );
        expect(session.model).toBe(`${provider}/${modelId}`);
        expect(createdSession?.thinkingLevel).toBe("high");
        expect(createdSession?.model?.contextWindow).toBe(600_000);
        expect(session.resumeCursor).toMatchObject({ context: "600k" });
        await Effect.runPromise(
          test.adapter.sendTurn({ threadId, input: "Confirm effort", attachments: [] }),
        );
        await collectThrough(test.adapter.streamEvents, (event) => event.type === "turn.completed");
        const sessionFile = (session.resumeCursor as { readonly sessionFile: string }).sessionFile;
        const entries = NodeFS.readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as { readonly type?: string; readonly thinkingLevel?: string },
          );
        expect(entries).toContainEqual(
          expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }),
        );
      } finally {
        await test.cleanup();
      }
    },
  );

  it("rejects unsupported context before creating a provider session", async () => {
    let sessionsCreated = 0;
    const test = await fixture([], () => {
      sessionsCreated += 1;
    });
    try {
      const ordinary = test.faux.models[0]!;
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-unsupported-context"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: `${ordinary.provider}/${ordinary.id}`,
              options: [{ id: "context", value: "600k" }],
            },
          }),
        ),
      ).rejects.toThrow("does not support an editable context choice");
      expect(sessionsCreated).toBe(0);
    } finally {
      await test.cleanup();
    }
  });

  it("rejects an unsupported context before prompting an existing provider session", async () => {
    const test = await fixture([]);
    try {
      const ordinary = test.faux.models[0]!;
      const threadId = ThreadId.make("pi-unsupported-context-switch");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi-test"),
            model: `${ordinary.provider}/${ordinary.id}`,
          },
        }),
      );

      await expect(
        Effect.runPromise(
          test.adapter.sendTurn({
            threadId,
            input: "This prompt must not reach Pi",
            attachments: [],
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: `${ordinary.provider}/${ordinary.id}`,
              options: [{ id: "context", value: "600k" }],
            },
          }),
        ),
      ).rejects.toThrow("does not support an editable context choice");
      expect(test.registry.find(ordinary.provider, ordinary.id)?.contextWindow).toBe(
        ordinary.contextWindow,
      );
    } finally {
      await test.cleanup();
    }
  });

  it("rejects unknown Pi option ids instead of silently using medium", async () => {
    const test = await fixture([]);
    try {
      const model = test.faux.models[0]!;
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-unknown-option"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: `${model.provider}/${model.id}`,
              options: [{ id: "mystery", value: "high" }],
            },
          }),
        ),
      ).rejects.toThrow("Unsupported Pi provider option 'mystery'");
    } finally {
      await test.cleanup();
    }
  });

  it("refuses a production-like start without ProviderService MCP preparation", async () => {
    const test = await fixture([], undefined, undefined, false);
    try {
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-missing-mcp"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
          }),
        ),
      ).rejects.toThrow("requires an active Starcode MCP credential");
    } finally {
      await test.cleanup();
    }
  });

  it("passes distinct top-level task and attached-agent tools into Pi", async () => {
    await withPiMcpDescriptorServer(async (endpoint) => {
      const toolSets: Array<ReadonlyArray<string>> = [];
      const test = await fixture([], (_session, names) => {
        toolSets.push(names);
      });
      const threadId = ThreadId.make("pi-task-tools");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-pi-test"),
        threadId,
        providerSessionId: "provider-session-pi-test",
        providerInstanceId: ProviderInstanceId.make("pi-test"),
        endpoint,
        authorizationHeader: "Bearer pi-adapter-test",
      });
      try {
        await Effect.runPromise(
          test.adapter.startSession({
            threadId,
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
          }),
        );
        await Effect.runPromise(test.adapter.stopSession(threadId));
        await Effect.runPromise(
          test.adapter.startSession({
            threadId,
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
          }),
        );
        expect(toolSets).toHaveLength(2);
        for (const customToolNames of toolSets) {
          expect(customToolNames).toContain("starcode_new_task");
          expect(customToolNames).toContain("starcode_read_task");
          expect(customToolNames).toContain("starcode_wait_task");
          expect(customToolNames).toContain("starcode_spawn_agent");
          expect(customToolNames.filter((name) => name === "starcode_new_task")).toHaveLength(1);
          expect(customToolNames.filter((name) => name === "starcode_spawn_agent")).toHaveLength(1);
        }
      } finally {
        McpProviderSession.clearMcpProviderSession(threadId);
        await test.cleanup();
      }
    });
  });

  it("streams text, usage, durable resume state, and a terminal turn without blank cards", async () => {
    const test = await fixture([fauxAssistantMessage("Visible Pi result")]);
    try {
      const threadId = ThreadId.make("pi-streaming");
      const session = await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      assert.ok(
        typeof (session.resumeCursor as { sessionFile?: unknown }).sessionFile === "string",
      );
      const sent = await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Respond", attachments: [] }),
      );
      expect((sent.resumeCursor as { activeTurnId?: string }).activeTurnId).toBe(sent.turnId);
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );
      assert.ok(events.some((event) => event.type === "content.delta"));
      assert.ok(
        events.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message" &&
            event.payload.output === "Visible Pi result",
        ),
      );
      assert.ok(events.some((event) => event.type === "thread.token-usage.updated"));
      assert.strictEqual(events.at(-1)?.type, "turn.completed");

      await Effect.runPromise(test.adapter.stopSession(threadId));
      const resumed = await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        }),
      );
      assert.strictEqual(
        (resumed.resumeCursor as { sessionId: string }).sessionId,
        (session.resumeCursor as { sessionId: string }).sessionId,
      );
    } finally {
      await test.cleanup();
    }
  });

  it("forks a durable Pi transcript into a new idle session without mutating its source", async () => {
    const test = await fixture([
      fauxAssistantMessage("Source result"),
      fauxAssistantMessage("Fork result"),
    ]);
    try {
      const sourceThreadId = ThreadId.make("pi-fork-source");
      const source = await Effect.runPromise(
        test.adapter.startSession({
          threadId: sourceThreadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({
          threadId: sourceThreadId,
          input: "Create source history",
          attachments: [],
        }),
      );
      await collectThrough(test.adapter.streamEvents, (event) => event.type === "turn.completed");
      await Effect.runPromise(test.adapter.stopSession(sourceThreadId));

      const sourceCursor = source.resumeCursor as {
        readonly sessionFile: string;
        readonly sessionId: string;
      };
      const sourceBeforeFork = NodeFS.readFileSync(sourceCursor.sessionFile, "utf8");
      const forkCwd = NodePath.join(test.directory, "fork-target");
      NodeFS.mkdirSync(forkCwd, { recursive: true });
      const forkThreadId = ThreadId.make("pi-fork-target");
      const forked = await Effect.runPromise(
        test.adapter.startSession({
          threadId: forkThreadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: forkCwd,
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("must-not-survive-fork"),
          resumeCursor: {
            ...sourceCursor,
            fork: true,
            activeTurnId: "must-not-survive-fork",
            attached: {
              parentThreadId: "must-not-survive-fork",
              agentRunId: "agent:must-not-survive-fork",
              depth: 2,
            },
          },
        }),
      );

      const forkCursor = forked.resumeCursor as Record<string, unknown> & {
        readonly sessionFile: string;
        readonly sessionId: string;
      };
      expect(forked.status).toBe("ready");
      expect(forked.activeTurnId).toBeUndefined();
      expect(forkCursor.sessionId).not.toBe(sourceCursor.sessionId);
      expect(forkCursor.sessionFile).not.toBe(sourceCursor.sessionFile);
      expect(forkCursor).not.toHaveProperty("fork");
      expect(forkCursor).not.toHaveProperty("activeTurnId");
      expect(forkCursor).not.toHaveProperty("attached");
      const forkHeader = JSON.parse(
        NodeFS.readFileSync(forkCursor.sessionFile, "utf8").split("\n")[0]!,
      ) as Record<string, unknown>;
      expect(forkHeader).toMatchObject({
        type: "session",
        cwd: forkCwd,
        parentSession: sourceCursor.sessionFile,
      });
      expect(NodeFS.readFileSync(sourceCursor.sessionFile, "utf8")).toBe(sourceBeforeFork);

      await Effect.runPromise(
        test.adapter.sendTurn({
          threadId: forkThreadId,
          input: "Continue only in fork",
          attachments: [],
        }),
      );
      await collectThrough(test.adapter.streamEvents, (event) => event.type === "turn.completed");
      expect(NodeFS.readFileSync(sourceCursor.sessionFile, "utf8")).toBe(sourceBeforeFork);
    } finally {
      await test.cleanup();
    }
  });

  it("rejects a missing Pi fork source without creating a blank replacement session", async () => {
    let sessionsCreated = 0;
    const test = await fixture([], () => {
      sessionsCreated += 1;
    });
    try {
      const missingSource = NodePath.join(test.directory, "missing-source.jsonl");
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-fork-missing-source"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            resumeCursor: {
              sessionFile: missingSource,
              sessionId: "missing-source",
              fork: true,
            },
          }),
        ),
      ).rejects.toThrow(`source transcript '${missingSource}' does not exist`);
      expect(sessionsCreated).toBe(0);
      expect(await Effect.runPromise(test.adapter.listSessions())).toEqual([]);
    } finally {
      await test.cleanup();
    }
  });

  it("shuts down Pi resources without publishing a user-visible stopped lifecycle", async () => {
    const test = await fixture([]);
    try {
      const threadId = ThreadId.make("pi-graceful-service-shutdown");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "session.state.changed",
      );

      await Effect.runPromise(test.adapter.stopAll());

      const nextEvent = await Effect.runPromise(
        Stream.runHead(test.adapter.streamEvents).pipe(Effect.timeoutOption(Duration.millis(75))),
      );
      expect(Option.isNone(nextEvent)).toBe(true);
      expect(await Effect.runPromise(test.adapter.hasSession(threadId))).toBe(false);
    } finally {
      await test.cleanup();
    }
  });

  it("emits an attributed nested user-message item for an attached AgentRun turn", async () => {
    const test = await fixture([fauxAssistantMessage("Nested response")]);
    try {
      const threadId = ThreadId.make("attached:test-user-message");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          resumeCursor: {
            sessionFile: "",
            sessionId: "",
            attached: {
              parentThreadId: ThreadId.make("parent-task"),
              agentRunId: "agent:test-user-message",
              depth: 1,
            },
          },
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Nested follow-up", attachments: [] }),
      );
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );
      expect(
        events.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "user_message" &&
            event.payload.output === "Nested follow-up",
        ),
      ).toBe(true);
    } finally {
      await test.cleanup();
    }
  });

  it("repairs an interrupted tool result and continues the same durable turn after restart", async () => {
    const test = await fixture([
      fauxAssistantMessage("Initial turn completed"),
      fauxAssistantMessage("Recovered work completed on the original turn"),
    ]);
    try {
      const threadId = ThreadId.make("pi-process-restart-recovery");
      const initial = await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Initialize transcript", attachments: [] }),
      );
      await collectThrough(test.adapter.streamEvents, (event) => event.type === "turn.completed");
      await Effect.runPromise(test.adapter.stopSession(threadId));

      const sessionFile = (initial.resumeCursor as { readonly sessionFile: string }).sessionFile;
      const persisted = SessionManager.open(
        sessionFile,
        NodePath.dirname(sessionFile),
        test.directory,
      );
      persisted.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Run a command before restart" }],
        timestamp: Date.now(),
      });
      const interruptedCall = fauxToolCall("bash", { command: "printf interrupted" });
      persisted.appendMessage(fauxAssistantMessage(interruptedCall));

      const recoveredTurnId = TurnId.make("turn-survives-process-restart");
      const resumed = await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          resumeCursor: {
            ...(initial.resumeCursor as Record<string, unknown>),
            activeTurnId: recoveredTurnId,
          },
          activeTurnId: recoveredTurnId,
        }),
      );
      expect(resumed.status).toBe("running");
      expect(resumed.activeTurnId).toBe(recoveredTurnId);

      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed" && event.turnId === recoveredTurnId,
      );
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          turnId: recoveredTurnId,
          itemId: interruptedCall.id,
          payload: expect.objectContaining({
            itemType: "command_execution",
            status: "stopped",
            title: "bash",
            output: expect.stringMatching(/server restarted/i),
          }),
        }),
      );
      const recoveryStarted = events.find(
        (event) =>
          event.type === "item.started" &&
          event.payload.title === "Recovering Pi turn after restart",
      );
      const recoveryCompleted = events.find(
        (event) =>
          event.type === "item.completed" &&
          event.payload.title === "Pi turn recovered after restart",
      );
      assert.ok(recoveryStarted?.type === "item.started");
      assert.ok(recoveryCompleted?.type === "item.completed");
      expect(recoveryCompleted.itemId).toBe(recoveryStarted.itemId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "content.delta",
          turnId: recoveredTurnId,
          itemId: recoveryStarted.itemId,
          payload: expect.objectContaining({
            streamKind: "reasoning_text",
            delta: expect.stringMatching(/Recovering the same Pi turn/),
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          turnId: recoveredTurnId,
          payload: expect.objectContaining({
            itemType: "assistant_message",
            output: "Recovered work completed on the original turn",
          }),
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        turnId: recoveredTurnId,
        payload: { state: "completed" },
      });

      const persistedMessages = NodeFS.readFileSync(sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly message?: { readonly role?: string } });
      expect(persistedMessages.some((entry) => entry.message?.role === "toolResult")).toBe(true);
    } finally {
      await test.cleanup();
    }
  });

  it("replays durable pending input when Pi has not flushed its first assistant response", async () => {
    const test = await fixture(
      [
        () => new Promise(() => undefined),
        () => new Promise(() => undefined),
        fauxAssistantMessage("Recovered the first response from Starcode's durable cursor"),
      ],
      undefined,
      1,
    );
    const recoveredAdapters: Array<typeof test.adapter> = [];
    try {
      const threadId = ThreadId.make("pi-pending-first-response-recovery");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      const active = await Effect.runPromise(
        test.adapter.sendTurn({
          threadId,
          input: "Complete this turn after Starcode restarts",
          attachments: [],
        }),
      );
      expect(active.resumeCursor).toMatchObject({
        activeTurnId: active.turnId,
        pendingTurnInputs: [
          {
            input: "Complete this turn after Starcode restarts",
            attachments: [],
          },
        ],
      });

      const sessionFile = (active.resumeCursor as { readonly sessionFile: string }).sessionFile;
      expect(NodeFS.existsSync(sessionFile)).toBe(false);
      await Effect.runPromise(test.adapter.stopAll());

      const recoveredAdapter = await Effect.runPromise(
        makePiAdapter({
          instanceId: ProviderInstanceId.make("pi-test"),
          config: decodePiSettings({ enabledModels: ["starcode-faux/*"] }),
          agentDir: NodePath.join(test.directory, "agent"),
          attachmentsDir: NodePath.join(test.directory, "attachments"),
          modelRegistry: test.registry,
          modelRuntime: test.modelRuntime,
          allowMissingMcpForTests: true,
          stopGraceMs: 1,
        }),
      );
      recoveredAdapters.push(recoveredAdapter);
      const resumedOnce = await Effect.runPromise(
        recoveredAdapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          resumeCursor: active.resumeCursor,
          activeTurnId: active.turnId,
        }),
      );
      expect(resumedOnce.resumeCursor).toMatchObject({
        activeTurnId: active.turnId,
        pendingTurnInputs: [
          {
            input: "Complete this turn after Starcode restarts",
            attachments: [],
          },
        ],
      });
      const onceRecoveredSessionFile = (
        resumedOnce.resumeCursor as { readonly sessionFile: string }
      ).sessionFile;
      expect(NodeFS.existsSync(onceRecoveredSessionFile)).toBe(false);
      await Effect.runPromise(recoveredAdapter.stopAll());

      const recoveredAgain = await Effect.runPromise(
        makePiAdapter({
          instanceId: ProviderInstanceId.make("pi-test"),
          config: decodePiSettings({ enabledModels: ["starcode-faux/*"] }),
          agentDir: NodePath.join(test.directory, "agent"),
          attachmentsDir: NodePath.join(test.directory, "attachments"),
          modelRegistry: test.registry,
          modelRuntime: test.modelRuntime,
          allowMissingMcpForTests: true,
          stopGraceMs: 1,
        }),
      );
      recoveredAdapters.push(recoveredAgain);
      const resumed = await Effect.runPromise(
        recoveredAgain.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          resumeCursor: resumedOnce.resumeCursor,
          activeTurnId: active.turnId,
        }),
      );
      const events = await collectThrough(
        recoveredAgain.streamEvents,
        (event) => event.type === "turn.completed" && event.turnId === active.turnId,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          turnId: active.turnId,
          payload: expect.objectContaining({
            itemType: "assistant_message",
            output: "Recovered the first response from Starcode's durable cursor",
          }),
        }),
      );
      const recoveredSessionFile = (resumed.resumeCursor as { readonly sessionFile: string })
        .sessionFile;
      expect(NodeFS.readFileSync(recoveredSessionFile, "utf8")).toContain(
        "Complete this turn after Starcode restarts",
      );
      expect(NodeFS.readFileSync(recoveredSessionFile, "utf8")).toContain(
        "starcode.pi.pending-input-consumed",
      );
    } finally {
      for (const adapter of recoveredAdapters) await Effect.runPromise(adapter.stopAll());
      await test.cleanup();
    }
  });

  it("replays accepted steering input in order when the first response never flushed", async () => {
    const test = await fixture(
      [
        () => new Promise(() => undefined),
        (context) =>
          fauxAssistantMessage(
            context.messages
              .flatMap((message) =>
                message.role === "user"
                  ? typeof message.content === "string"
                    ? [message.content]
                    : message.content.flatMap((block) =>
                        block.type === "text" ? [block.text] : [],
                      )
                  : [],
              )
              .join(" | "),
          ),
      ],
      undefined,
      1,
    );
    let recoveredAdapter: typeof test.adapter | undefined;
    try {
      const threadId = ThreadId.make("pi-pending-steering-recovery");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Original prompt", attachments: [] }),
      );
      await expect.poll(() => test.faux.state.callCount).toBe(1);
      const steered = await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Steering follow-up", attachments: [] }),
      );
      expect(steered.resumeCursor).toMatchObject({
        pendingTurnInputs: [
          { input: "Original prompt", attachments: [] },
          { input: "Steering follow-up", attachments: [] },
        ],
      });
      await Effect.runPromise(test.adapter.stopAll());

      recoveredAdapter = await Effect.runPromise(
        makePiAdapter({
          instanceId: ProviderInstanceId.make("pi-test"),
          config: decodePiSettings({ enabledModels: ["starcode-faux/*"] }),
          agentDir: NodePath.join(test.directory, "agent"),
          attachmentsDir: NodePath.join(test.directory, "attachments"),
          modelRegistry: test.registry,
          modelRuntime: test.modelRuntime,
          allowMissingMcpForTests: true,
          stopGraceMs: 1,
        }),
      );
      await Effect.runPromise(
        recoveredAdapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          resumeCursor: steered.resumeCursor,
          activeTurnId: steered.turnId,
        }),
      );
      const events = await collectThrough(
        recoveredAdapter.streamEvents,
        (event) => event.type === "turn.completed" && event.turnId === steered.turnId,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          turnId: steered.turnId,
          payload: expect.objectContaining({
            itemType: "assistant_message",
            output: "Original prompt | Steering follow-up",
          }),
        }),
      );
    } finally {
      if (recoveredAdapter) await Effect.runPromise(recoveredAdapter.stopAll());
      await test.cleanup();
    }
  });

  it("replays only the steering suffix missing after a flushed transcript prefix", async () => {
    const test = await fixture([
      fauxAssistantMessage("Prior completed turn"),
      fauxAssistantMessage("Recovered only the missing steering suffix"),
    ]);
    try {
      const threadId = ThreadId.make("pi-partial-steering-recovery");
      const initial = await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Prior prompt", attachments: [] }),
      );
      await collectThrough(test.adapter.streamEvents, (event) => event.type === "turn.completed");
      await Effect.runPromise(test.adapter.stopSession(threadId));

      const sessionFile = (initial.resumeCursor as { readonly sessionFile: string }).sessionFile;
      const persisted = SessionManager.open(
        sessionFile,
        NodePath.dirname(sessionFile),
        test.directory,
      );
      const originalInputId = "00000000-0000-4000-8000-000000000001";
      const steeringInputId = "00000000-0000-4000-8000-000000000002";
      persisted.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Original active prompt" }],
        timestamp: Date.now(),
      });
      persisted.appendMessage(fauxAssistantMessage("Flushed response before queued steering"));
      persisted.appendCustomEntry("starcode.pi.pending-input-consumed", {
        inputId: originalInputId,
      });

      const recoveredTurnId = TurnId.make("turn-partial-steering-recovery");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
          activeTurnId: recoveredTurnId,
          resumeCursor: {
            ...(initial.resumeCursor as Record<string, unknown>),
            activeTurnId: recoveredTurnId,
            pendingTurnInputs: [
              { id: originalInputId, input: "Original active prompt", attachments: [] },
              { id: steeringInputId, input: "Missing steering suffix", attachments: [] },
            ],
          },
        }),
      );
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed" && event.turnId === recoveredTurnId,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          turnId: recoveredTurnId,
          payload: expect.objectContaining({
            itemType: "assistant_message",
            output: "Recovered only the missing steering suffix",
          }),
        }),
      );
      const userMessages = NodeFS.readFileSync(sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly message?: { readonly role?: string } })
        .filter((entry) => entry.message?.role === "user");
      expect(userMessages).toHaveLength(3);
    } finally {
      await test.cleanup();
    }
  });

  it("rejects malformed durable pending input instead of mutating replay", async () => {
    const test = await fixture([]);
    try {
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-invalid-pending-input"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-invalid-pending-input"),
            resumeCursor: {
              sessionFile: NodePath.join(test.directory, "missing.jsonl"),
              sessionId: "missing",
              pendingTurnInputs: [
                {
                  id: "00000000-0000-4000-8000-000000000003",
                  input: "x".repeat(120_001),
                  attachments: [],
                },
              ],
            },
          }),
        ),
      ).rejects.toThrow(/pendingTurnInputs|120000|length/iu);
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-empty-pending-input"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-empty-pending-input"),
            resumeCursor: {
              sessionFile: NodePath.join(test.directory, "missing-empty.jsonl"),
              sessionId: "missing-empty",
              pendingTurnInputs: [{ id: "00000000-0000-4000-8000-000000000004", attachments: [] }],
            },
          }),
        ),
      ).rejects.toThrow(/requires text|attachment/iu);
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-too-many-pending-inputs"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-too-many-pending-inputs"),
            resumeCursor: {
              sessionFile: NodePath.join(test.directory, "missing-many.jsonl"),
              sessionId: "missing-many",
              pendingTurnInputs: Array.from({ length: 33 }, (_, index) => ({
                id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
                input: `message ${index}`,
                attachments: [],
              })),
            },
          }),
        ),
      ).rejects.toThrow(/32|length/iu);
      const duplicateId = "00000000-0000-4000-8000-000000000005";
      await expect(
        Effect.runPromise(
          test.adapter.startSession({
            threadId: ThreadId.make("pi-duplicate-pending-inputs"),
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd: test.directory,
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-duplicate-pending-inputs"),
            resumeCursor: {
              sessionFile: NodePath.join(test.directory, "missing-duplicate.jsonl"),
              sessionId: "missing-duplicate",
              pendingTurnInputs: [
                { id: duplicateId, input: "first", attachments: [] },
                { id: duplicateId, input: "second", attachments: [] },
              ],
            },
          }),
        ),
      ).rejects.toThrow(/unique/iu);
    } finally {
      await test.cleanup();
    }
  });

  it("keeps the same turn alive and visibly recovers from a transient WebSocket failure", async () => {
    const test = await fixture([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "WebSocket error",
      }),
      fauxAssistantMessage("Recovered on the same Pi turn"),
    ]);
    try {
      const threadId = ThreadId.make("pi-transient-websocket-recovery");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Recover without a new turn", attachments: [] }),
      );
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );

      expect(test.faux.state.callCount).toBe(2);
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: { state: "completed" },
      });
      expect(events.some((event) => event.type === "runtime.error")).toBe(false);

      const retryStarted = events.find(
        (event) =>
          event.type === "item.started" && event.payload.title === "Recovering Pi connection",
      );
      assert.ok(retryStarted?.type === "item.started");
      expect(retryStarted.payload).toMatchObject({
        itemType: "reasoning",
        status: "inProgress",
        detail: "Attempt 1 of 3 in 2000ms",
        output: "WebSocket error",
      });
      const retryCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.title === "Pi connection recovered",
      );
      assert.ok(retryCompleted?.type === "item.completed");
      expect(retryCompleted.itemId).toBe(retryStarted.itemId);
      expect(retryCompleted.payload).toMatchObject({
        status: "completed",
        output: "Pi resumed the same turn after a transient provider connection failure.",
      });
      expect(
        events.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message" &&
            event.payload.output === "Recovered on the same Pi turn",
        ),
      ).toBe(true);
    } finally {
      await test.cleanup();
    }
  });

  it("fails once, visibly, only after Pi exhausts transient recovery", async () => {
    const websocketFailure = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "WebSocket error" });
    const test = await fixture(
      [websocketFailure(), websocketFailure(), websocketFailure(), websocketFailure()],
      (session) => {
        const settings = (
          session as unknown as {
            readonly settingsManager: {
              getRetrySettings: () => {
                enabled: boolean;
                maxRetries: number;
                baseDelayMs: number;
              };
            };
          }
        ).settingsManager;
        settings.getRetrySettings = () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1 });
      },
    );
    try {
      const threadId = ThreadId.make("pi-transient-websocket-exhausted");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Exhaust recovery", attachments: [] }),
      );
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );

      expect(test.faux.state.callCount).toBe(4);
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: { state: "failed", errorMessage: "WebSocket error" },
      });
      expect(
        events.filter(
          (event) =>
            (event.type === "item.started" || event.type === "item.updated") &&
            event.payload.title === "Recovering Pi connection",
        ),
      ).toHaveLength(3);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          payload: expect.objectContaining({
            status: "failed",
            title: "Pi connection recovery failed",
            detail: "3 attempts",
            output: "WebSocket error",
          }),
        }),
      );
    } finally {
      await test.cleanup();
    }
  });

  it("cancels a pending Pi retry as the same interrupted turn", async () => {
    const test = await fixture([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "WebSocket error" }),
    ]);
    try {
      const threadId = ThreadId.make("pi-transient-websocket-cancelled");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      const sent = await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Cancel recovery", attachments: [] }),
      );
      const beforeInterrupt = await collectThrough(
        test.adapter.streamEvents,
        (event) =>
          event.type === "item.started" && event.payload.title === "Recovering Pi connection",
      );
      expect(beforeInterrupt.some((event) => event.type === "turn.completed")).toBe(false);

      await Effect.runPromise(test.adapter.interruptTurn(threadId, sent.turnId));
      const afterInterrupt = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );
      expect(afterInterrupt).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          payload: expect.objectContaining({
            status: "stopped",
            title: "Pi connection recovery stopped",
          }),
        }),
      );
      expect(afterInterrupt.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: { state: "interrupted" },
      });
      expect(test.faux.state.callCount).toBe(1);
    } finally {
      await test.cleanup();
    }
  });

  it("shows approval, command start/output/terminal state, and resolved approval in order", async () => {
    const test = await fixture([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf pi-tool-output" })),
      fauxAssistantMessage("Command observed"),
    ]);
    try {
      const threadId = ThreadId.make("pi-approval");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "approval-required",
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Run the command", attachments: [] }),
      );
      const beforeApproval = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "request.opened",
      );
      const opened = beforeApproval.at(-1)!;
      assert.strictEqual(opened.type, "request.opened");
      if (opened.type !== "request.opened") return;
      await Effect.runPromise(
        test.adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(opened.requestId)),
          "accept",
        ),
      );
      const afterApproval = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );
      assert.strictEqual(afterApproval[0]?.type, "request.resolved");
      if (afterApproval[0]?.type !== "request.resolved") return;
      assert.strictEqual(afterApproval[0].payload.decision, "accept");
      assert.strictEqual(afterApproval[0].payload.detail, "bash: printf pi-tool-output");
      assert.deepStrictEqual(afterApproval[0].payload.args, {
        command: "printf pi-tool-output",
      });
      const command = afterApproval.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.ok(command && command.type === "item.completed");
      assert.match(
        command && command.type === "item.completed" ? (command.payload.output ?? "") : "",
        /pi-tool-output/,
      );
      assert.strictEqual(afterApproval.at(-1)?.type, "turn.completed");
      assert.ok(
        [...beforeApproval, ...afterApproval].every(
          (event) =>
            event.type !== "item.completed" ||
            event.payload.itemType !== "assistant_message" ||
            event.payload.output !== "Pi completed without textual output.",
        ),
      );
    } finally {
      await test.cleanup();
    }
  });

  it("emits a self-contained file-read lifecycle with a visible target and result", async () => {
    const test = await fixture([
      fauxAssistantMessage(fauxToolCall("read", { path: "package.json" })),
      fauxAssistantMessage("Read observed"),
    ]);
    try {
      NodeFS.writeFileSync(
        NodePath.join(test.directory, "package.json"),
        JSON.stringify({ name: "pi-read-e2e" }),
      );
      const threadId = ThreadId.make("pi-read");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Read package.json", attachments: [] }),
      );
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );
      const readEvents = events.filter(
        (event) =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          event.payload.itemType === "file_read",
      );
      assert.ok(readEvents.some((event) => event.type === "item.started"));
      const completed = readEvents.find((event) => event.type === "item.completed");
      assert.ok(completed && completed.type === "item.completed");
      if (!completed || completed.type !== "item.completed") return;
      const terminalTurnIndex = events.findIndex((event) => event.type === "turn.completed");
      const terminalReadIndex = events.findIndex(
        (event) => event.type === "item.completed" && event.itemId === completed.itemId,
      );
      assert.isAtLeast(terminalReadIndex, 0);
      assert.isAbove(terminalTurnIndex, terminalReadIndex);
      assert.strictEqual(completed.payload.title, "read");
      assert.strictEqual(completed.payload.detail, "package.json");
      assert.match(completed.payload.output ?? "", /pi-read-e2e/);
      assert.deepInclude(completed.payload.data, {
        toolName: "read",
        input: { path: "package.json" },
      });
    } finally {
      await test.cleanup();
    }
  });

  it("maps Pi compaction into a complete visible lifecycle", async () => {
    let session: AgentSession | undefined;
    const test = await fixture([], (created) => {
      session = created;
    });
    try {
      const threadId = ThreadId.make("pi-compaction");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      assert.ok(session);
      const emit = (session as unknown as { _emit: (event: unknown) => void })._emit.bind(session);
      emit({ type: "compaction_start", reason: "threshold" });
      emit({
        type: "compaction_end",
        reason: "threshold",
        result: {},
        aborted: false,
        willRetry: false,
      });

      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      const lifecycle = events.filter(
        (event) =>
          (event.type === "item.started" || event.type === "item.completed") &&
          event.payload.itemType === "context_compaction",
      );
      assert.deepStrictEqual(
        lifecycle.map((event) => event.type),
        ["item.started", "item.completed"],
      );
      assert.strictEqual(lifecycle[0]?.itemId, lifecycle[1]?.itemId);
      const completed = lifecycle[1];
      assert.ok(completed?.type === "item.completed");
      if (completed?.type !== "item.completed") return;
      assert.strictEqual(completed.payload.status, "completed");
      assert.strictEqual(completed.payload.output, "Context compacted successfully.");
    } finally {
      await test.cleanup();
    }
  });

  it("interrupts an active stream and terminates the turn", async () => {
    const test = await fixture([
      fauxAssistantMessage(
        "This response is intentionally long enough to remain streaming for interruption.",
      ),
    ]);
    try {
      const threadId = ThreadId.make("pi-interrupt");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      const turn = await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Stream", attachments: [] }),
      );
      await Effect.runPromise(test.adapter.interruptTurn(threadId, turn.turnId));
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );
      const completed = events.at(-1)!;
      assert.strictEqual(completed.type, "turn.completed");
      assert.ok(
        completed.type === "turn.completed" &&
          (completed.payload.state === "interrupted" || completed.payload.state === "completed"),
      );
    } finally {
      await test.cleanup();
    }
  });

  it("marks an interrupted command as stopped with tangible output", async () => {
    const test = await fixture([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" })),
      fauxAssistantMessage("SHOULD-NOT-APPEAR"),
    ]);
    try {
      const threadId = ThreadId.make("pi-command-interrupt");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );
      const turn = await Effect.runPromise(
        test.adapter.sendTurn({ threadId, input: "Run a long command", attachments: [] }),
      );
      const started = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "item.started" && event.payload.itemType === "command_execution",
      );
      assert.ok(started.some((event) => event.type === "item.started"));

      await Effect.runPromise(test.adapter.interruptTurn(threadId, turn.turnId));
      const events = await collectThrough(
        test.adapter.streamEvents,
        (event) => event.type === "turn.completed",
      );
      const command = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.ok(command && command.type === "item.completed");
      if (!command || command.type !== "item.completed") return;
      assert.strictEqual(command.payload.status, "stopped");
      assert.match(command.payload.output ?? "", /aborted|cancelled|stopped/i);
      assert.ok(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
        ),
      );
      assert.ok(
        !events.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message" &&
            event.payload.output === "SHOULD-NOT-APPEAR",
        ),
      );
    } finally {
      await test.cleanup();
    }
  });

  it("disposes a Pi session when abort never acknowledges shutdown", async () => {
    let disposed = false;
    const test = await fixture(
      [],
      (session) => {
        session.abort = () => new Promise<void>(() => undefined);
        const dispose = session.dispose.bind(session);
        session.dispose = () => {
          disposed = true;
          dispose();
        };
      },
      5,
    );
    try {
      const threadId = ThreadId.make("pi-stuck-abort");
      await Effect.runPromise(
        test.adapter.startSession({
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          cwd: test.directory,
          runtimeMode: "full-access",
        }),
      );

      await Effect.runPromise(test.adapter.stopSession(threadId));

      assert.isTrue(disposed);
      assert.isFalse(await Effect.runPromise(test.adapter.hasSession(threadId)));
    } finally {
      await test.cleanup();
    }
  });
});
