import { ProviderInstanceId, ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import { setAttachedAgentHost, type SpawnAttachedAgentInput } from "../AttachedAgentHost.ts";
import { createPiAttachedAgentTools } from "./PiAttachedAgentTools.ts";

describe("Pi same-task agent tools", () => {
  it("passes the current AgentRun as message attribution", async () => {
    const sent: unknown[][] = [];
    setAttachedAgentHost({
      spawn: async () => {
        throw new Error("not used");
      },
      sendMessage: async (...args) => {
        sent.push(args);
        return {
          agentRunId: String(args[1]),
          parentThreadId: args[0],
          providerInstanceId: ProviderInstanceId.make("pi"),
          description: "destination",
          status: "running",
          startedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
      },
      wait: async () => [],
      status: () => [],
      cancel: async () => {
        throw new Error("not used");
      },
      interruptTurn: async () => {
        throw new Error("not used");
      },
      cancelParent: async () => undefined,
    });
    try {
      const send = createPiAttachedAgentTools({
        parentThreadId: ThreadId.make("parent"),
        currentAgentRunId: "agent:sender",
        cwd: "/tmp/project",
        defaultProviderInstanceId: ProviderInstanceId.make("pi"),
        depth: 1,
        maxDepth: 3,
        maxChildren: 4,
      }).find((tool) => tool.name === "starcode_send_agent_message");
      await send!.execute(
        "call-send",
        { agentRunId: "agent:destination", message: "compare" },
        undefined,
        undefined,
        undefined as never,
      );
      expect(sent).toEqual([["parent", "agent:destination", "compare", "agent:sender"]]);
    } finally {
      setAttachedAgentHost(undefined);
    }
  });

  it("inherits the parent Pi model unless the call selects another model", async () => {
    const spawned: SpawnAttachedAgentInput[] = [];
    setAttachedAgentHost({
      spawn: async (input) => {
        spawned.push(input);
        return {
          agentRunId: `agent:${spawned.length}`,
          parentThreadId: input.parentThreadId,
          providerInstanceId: input.providerInstanceId,
          ...(input.model ? { model: input.model } : {}),
          description: input.description,
          status: "running",
          startedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
      },
      sendMessage: async () => {
        throw new Error("not used");
      },
      wait: async () => [],
      status: () => [],
      cancel: async () => {
        throw new Error("not used");
      },
      interruptTurn: async () => {
        throw new Error("not used");
      },
      cancelParent: async () => undefined,
    });

    try {
      const tools = createPiAttachedAgentTools({
        parentThreadId: ThreadId.make("parent"),
        cwd: "/tmp/project",
        defaultProviderInstanceId: ProviderInstanceId.make("pi"),
        defaultModel: "openai-codex/gpt-5.6-sol",
        defaultOptions: [{ id: "effort", value: "high" }],
        depth: 0,
        maxDepth: 3,
        maxChildren: 4,
      });
      const spawn = tools.find((tool) => tool.name === "starcode_spawn_agent");
      expect(spawn).toBeDefined();
      expect(spawn!.description).toContain("pi / openai-codex/gpt-5.6-sol");
      expect(spawn!.description).toContain("never guess");
      expect(spawn!.description).toContain(
        'Pi high reasoning with 1M context uses [{"id":"effort"',
      );
      expect(spawn!.description).toContain('{"id":"context","value":"1m"}');

      await spawn!.execute(
        "call-default",
        { prompt: "default", description: "default child" },
        undefined,
        undefined,
        undefined as never,
      );
      await spawn!.execute(
        "call-explicit",
        {
          prompt: "explicit",
          description: "explicit child",
          model: "anthropic/claude-opus-5",
        },
        undefined,
        undefined,
        undefined as never,
      );
      await spawn!.execute(
        "call-claude",
        {
          prompt: "review",
          description: "opus reviewer",
          providerInstanceId: "pi_work",
          model: "anthropic/claude-fable-5",
          providerOptions: [
            { id: "effort", value: "medium" },
            { id: "context", value: "600k" },
          ],
        },
        undefined,
        undefined,
        undefined as never,
      );

      expect(spawned.map((input) => input.model)).toEqual([
        "openai-codex/gpt-5.6-sol",
        "anthropic/claude-opus-5",
        "anthropic/claude-fable-5",
      ]);
      expect(spawned.map((input) => input.providerInstanceId)).toEqual(["pi", "pi", "pi_work"]);
      expect(spawned[0]?.options).toEqual([{ id: "effort", value: "high" }]);
      expect(spawned[1]?.options).toBeUndefined();
      expect(spawned[2]?.options).toEqual([
        { id: "effort", value: "medium" },
        { id: "context", value: "600k" },
      ]);
    } finally {
      setAttachedAgentHost(undefined);
    }
  });

  it("reads the effective parent selection when each child is spawned", async () => {
    const spawned: SpawnAttachedAgentInput[] = [];
    let liveSelection = {
      providerInstanceId: ProviderInstanceId.make("pi"),
      model: "openai-codex/gpt-5.6-sol",
      options: [
        { id: "effort", value: "medium" },
        { id: "context", value: "600k" },
      ],
    };
    setAttachedAgentHost({
      spawn: async (input) => {
        spawned.push(input);
        return {
          agentRunId: `agent:${spawned.length}`,
          parentThreadId: input.parentThreadId,
          providerInstanceId: input.providerInstanceId,
          ...(input.model ? { model: input.model } : {}),
          ...(input.options ? { options: input.options } : {}),
          description: input.description,
          status: "running",
          startedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
      },
      sendMessage: async () => {
        throw new Error("not used");
      },
      wait: async () => [],
      status: () => [],
      cancel: async () => {
        throw new Error("not used");
      },
      interruptTurn: async () => {
        throw new Error("not used");
      },
      cancelParent: async () => undefined,
    });

    try {
      const spawn = createPiAttachedAgentTools({
        parentThreadId: ThreadId.make("parent"),
        cwd: "/tmp/project",
        defaultProviderInstanceId: ProviderInstanceId.make("pi"),
        resolveDefaultSelection: () => liveSelection,
        depth: 0,
        maxDepth: 3,
        maxChildren: 4,
      }).find((tool) => tool.name === "starcode_spawn_agent")!;

      await spawn.execute(
        "spawn-before-switch",
        { prompt: "before", description: "before" },
        undefined,
        undefined,
        undefined as never,
      );
      liveSelection = {
        providerInstanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/claude-opus-5",
        options: [
          { id: "effort", value: "high" },
          { id: "context", value: "1m" },
        ],
      };
      await spawn.execute(
        "spawn-after-switch",
        { prompt: "after", description: "after" },
        undefined,
        undefined,
        undefined as never,
      );

      expect(spawned.map(({ model, options }) => ({ model, options }))).toEqual([
        {
          model: "openai-codex/gpt-5.6-sol",
          options: [
            { id: "effort", value: "medium" },
            { id: "context", value: "600k" },
          ],
        },
        {
          model: "anthropic/claude-opus-5",
          options: [
            { id: "effort", value: "high" },
            { id: "context", value: "1m" },
          ],
        },
      ]);
    } finally {
      setAttachedAgentHost(undefined);
    }
  });
});
