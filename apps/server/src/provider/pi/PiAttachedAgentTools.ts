import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ProviderInstanceId,
  type ProviderOptionSelections,
  type ThreadId,
} from "@starcode/contracts";

import { requireAttachedAgentHost } from "../AttachedAgentHost.ts";

export interface PiAttachedAgentToolContext {
  readonly parentThreadId: ThreadId;
  readonly currentAgentRunId?: string;
  readonly cwd: string;
  readonly defaultProviderInstanceId: ProviderInstanceId;
  readonly defaultModel?: string;
  readonly defaultOptions?: ProviderOptionSelections;
  /** Read at tool execution time so post-start model/effort/context switches inherit exactly. */
  readonly resolveDefaultSelection?: () => {
    readonly providerInstanceId: ProviderInstanceId;
    readonly model?: string;
    readonly options?: ProviderOptionSelections;
  };
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxChildren: number;
}

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: value,
});

/**
 * Starcode-authored collaboration tools. Their names deliberately say
 * "agent" and never "task": `starcode_new_task` is the separate operation.
 */
export function createPiAttachedAgentTools(
  context: PiAttachedAgentToolContext,
): ReadonlyArray<ToolDefinition> {
  const inheritedSelection = `${context.defaultProviderInstanceId}${context.defaultModel ? ` / ${context.defaultModel}` : ""}`;
  const spawn = defineTool({
    name: "starcode_spawn_agent",
    label: "Spawn same-task agent",
    description: `Spawn an independently-contextualized Pi subagent attached to this same Starcode task. It becomes an AgentRun in the parent timeline, not a separate task/sidebar conversation. Returns immediately so several agents can run in parallel. Every child runs through Pi; choose a heterogeneous model backend with an exact provider-qualified Pi model ID such as "anthropic/claude-opus-5", "anthropic/claude-fable-5", or "openai-codex/gpt-5.6-sol"; never guess or abbreviate provider instance IDs, model IDs, or option values. Omit providerInstanceId, model, and providerOptions together to inherit the exact current selection (${inheritedSelection}). Pi high reasoning with 1M context uses [{"id":"effort","value":"high"},{"id":"context","value":"1m"}].`,
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete instructions for the child agent." }),
      description: Type.String({ description: "Short human-readable purpose." }),
      providerInstanceId: Type.Optional(
        Type.String({
          description: `Exact case-sensitive configured Pi instance ID. Omit to inherit '${context.defaultProviderInstanceId}'. Non-Pi provider instances are rejected.`,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: context.defaultModel
            ? `Exact provider-qualified model ID. Omit to inherit '${context.defaultModel}'; do not abbreviate it (for example, do not turn it into 'gpt-5').`
            : "Exact provider-qualified model ID. Omit to let the selected provider choose its configured default; do not abbreviate model names.",
        }),
      ),
      providerOptions: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({
              minLength: 1,
              description:
                "Exact Pi option ID: 'effort' or 'context'. 'reasoningEffort' is accepted only as a compatibility alias for 'effort'.",
            }),
            value: Type.Union([Type.String({ minLength: 1 }), Type.Boolean()]),
          }),
          {
            description:
              "Provider option selections to apply and persist for this child. Omit only when inheriting the parent selection or intentionally accepting the chosen provider's defaults.",
          },
        ),
      ),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params) => {
      const liveDefault = context.resolveDefaultSelection?.() ?? {
        providerInstanceId: context.defaultProviderInstanceId,
        ...(context.defaultModel ? { model: context.defaultModel } : {}),
        ...(context.defaultOptions ? { options: context.defaultOptions } : {}),
      };
      const inheritsExactSelection =
        params.providerInstanceId === undefined &&
        params.model === undefined &&
        params.providerOptions === undefined;
      const options =
        params.providerOptions ?? (inheritsExactSelection ? liveDefault.options : undefined);
      const snapshot = await requireAttachedAgentHost().spawn({
        parentThreadId: context.parentThreadId,
        ...(context.currentAgentRunId ? { parentAgentRunId: context.currentAgentRunId } : {}),
        cwd: context.cwd,
        providerInstanceId: ProviderInstanceId.make(
          params.providerInstanceId ?? liveDefault.providerInstanceId,
        ),
        ...((params.model ?? liveDefault.model)
          ? { model: params.model ?? liveDefault.model }
          : {}),
        ...(options && options.length > 0 ? { options } : {}),
        prompt: params.prompt,
        description: params.description,
        depth: context.depth,
        maxDepth: context.maxDepth,
        maxChildren: context.maxChildren,
      });
      return textResult(snapshot);
    },
  });

  const send = defineTool({
    name: "starcode_send_agent_message",
    label: "Message same-task agent",
    description:
      "Send an ordered, attributed message to a running same-task agent. This does not create or address a top-level Starcode task.",
    parameters: Type.Object({
      agentRunId: Type.String(),
      message: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) =>
      textResult(
        await requireAttachedAgentHost().sendMessage(
          context.parentThreadId,
          params.agentRunId,
          params.message,
          context.currentAgentRunId,
        ),
      ),
  });

  const wait = defineTool({
    name: "starcode_wait_agents",
    label: "Wait for same-task agents",
    description:
      "Wait for selected same-task agents, or all attached agents when agentRunIds is omitted. Returns deterministic snapshots in spawn order and wakes when any selected agent reaches a terminal state.",
    parameters: Type.Object({
      agentRunIds: Type.Optional(Type.Array(Type.String())),
      timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 300000 })),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params) =>
      textResult(
        await requireAttachedAgentHost().wait(
          context.parentThreadId,
          params.agentRunIds,
          params.timeoutMs,
        ),
      ),
  });

  const status = defineTool({
    name: "starcode_agent_status",
    label: "Same-task agent status",
    description: "Read status and result snapshots for agents attached to this task.",
    parameters: Type.Object({
      agentRunIds: Type.Optional(Type.Array(Type.String())),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params) =>
      textResult(requireAttachedAgentHost().status(context.parentThreadId, params.agentRunIds)),
  });

  const cancel = defineTool({
    name: "starcode_cancel_agent",
    label: "Cancel same-task agent",
    description:
      "Cancel one attached agent without cancelling its siblings. Cancelling the parent task propagates to all still-running attached agents.",
    parameters: Type.Object({ agentRunId: Type.String() }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) =>
      textResult(
        await requireAttachedAgentHost().cancel(context.parentThreadId, params.agentRunId),
      ),
  });

  return [spawn, send, wait, status, cancel];
}
