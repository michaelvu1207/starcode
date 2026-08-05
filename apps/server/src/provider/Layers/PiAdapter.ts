// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - Pi's
// SessionManager and callback event API are intentionally Node-native boundaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import type { AgentMessage, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  ApprovalRequestId,
  EventId,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  type FleetSessionBootstrapSnapshotProvider,
  resolveFleetSessionBootstrapInstructions,
} from "../FleetSessionBootstrap.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { createPiAttachedAgentTools } from "../pi/PiAttachedAgentTools.ts";
import { createPiMcpTools } from "../pi/PiMcpTools.ts";
import { piModelSlug, resolvePiModel } from "../pi/PiModels.ts";
import {
  assertPiContextSupported,
  canonicalizePiProviderOptions,
  piDefaultContextForModel,
  piContextTokens,
  readPiContext,
  readPiEffort,
  type PiContext,
} from "../pi/PiProviderOptions.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const STARCODE_PI_INSTRUCTIONS = `You are Starcode's native Pi coding agent. Starcode owns the visible task timeline; Pi's SessionManager owns your lossless model transcript.

Two operations are intentionally different:
- starcode_spawn_agent creates a same-task AgentRun attached to this task. Use starcode_wait_agents and starcode_send_agent_message to coordinate it.
- starcode_new_task creates a separate top-level task that appears independently in Starcode's task list. Use starcode_read_task and starcode_wait_task to follow it. Use it only when independent user-owned continuation is desired.

Use goal_get/goal_progress/goal_complete/goal_blocked for a durable Starcode goal when one is attached. Prefer Starcode project, task, preview, and thread tools for product-native operations.`;

const PiPendingTurnInputId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
);
const PiPendingTurnInput = Schema.Struct({
  id: PiPendingTurnInputId,
  input: ProviderSendTurnInput.fields.input,
  attachments: ProviderSendTurnInput.fields.attachments,
});
type PiPendingTurnInput = typeof PiPendingTurnInput.Type;
const MAX_PENDING_TURN_INPUTS = 32;
const MAX_PENDING_TURN_INPUT_CHARS = 240_000;
const MAX_PENDING_TURN_ATTACHMENTS = 32;
const PiPendingTurnInputs = Schema.Array(PiPendingTurnInput).check(
  Schema.isMaxLength(MAX_PENDING_TURN_INPUTS),
);
const decodePiPendingTurnInput = Schema.decodeUnknownSync(PiPendingTurnInput);
const decodePiPendingTurnInputs = Schema.decodeUnknownSync(PiPendingTurnInputs);
const PI_PENDING_INPUT_CONSUMED_MARKER = "starcode.pi.pending-input-consumed";

function validatePendingTurnInputs(
  inputs: ReadonlyArray<PiPendingTurnInput>,
): ReadonlyArray<PiPendingTurnInput> {
  const inputChars = inputs.reduce((total, input) => total + (input.input?.length ?? 0), 0);
  const attachments = inputs.reduce((total, input) => total + (input.attachments?.length ?? 0), 0);
  if (inputs.length > MAX_PENDING_TURN_INPUTS) {
    throw new Error(`Pending Pi turn input exceeds the ${MAX_PENDING_TURN_INPUTS}-message limit.`);
  }
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length) {
    throw new Error("Pending Pi turn input IDs must be unique.");
  }
  if (inputs.some((input) => !input.input && (input.attachments?.length ?? 0) === 0)) {
    throw new Error("Every pending Pi turn input requires text or at least one attachment.");
  }
  if (inputChars > MAX_PENDING_TURN_INPUT_CHARS) {
    throw new Error(
      `Pending Pi turn input exceeds the ${MAX_PENDING_TURN_INPUT_CHARS}-character aggregate limit.`,
    );
  }
  if (attachments > MAX_PENDING_TURN_ATTACHMENTS) {
    throw new Error(
      `Pending Pi turn input exceeds the ${MAX_PENDING_TURN_ATTACHMENTS}-attachment aggregate limit.`,
    );
  }
  return inputs;
}

interface PiResumeCursor {
  readonly sessionFile: string;
  readonly sessionId: string;
  /** One-shot request to copy this transcript into a new Pi session. */
  readonly fork?: true;
  readonly activeTurnId?: string;
  readonly context?: PiContext;
  /**
   * Pi intentionally does not create a JSONL file until the first assistant
   * message is complete. Keep the accepted input in Starcode's durable cursor
   * so a process restart can replay a turn interrupted before that response.
   */
  readonly pendingTurnInputs?: ReadonlyArray<PiPendingTurnInput>;
  readonly attached?: {
    readonly parentThreadId: string;
    readonly agentRunId: string;
    readonly depth: number;
  };
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly toolName: string;
  readonly detail: string;
  readonly args: unknown;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

interface PiTurnContext {
  readonly turnId: TurnId;
  readonly startedAt: number;
  readonly items: Array<unknown>;
  readonly messageItems: Map<number, RuntimeItemId>;
  readonly toolItems: Map<
    string,
    { readonly itemId: RuntimeItemId; readonly toolName: string; readonly args: unknown }
  >;
  completed: boolean;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly agent: AgentSession;
  readonly unsubscribe: () => void;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly acceptedTools: Set<string>;
  readonly approvalPolicy: ProviderSessionStartInput["approvalPolicy"];
  readonly sandboxMode: ProviderSessionStartInput["sandboxMode"];
  readonly parentThreadId: ThreadId;
  readonly currentAgentRunId?: string;
  readonly depth: number;
  context: PiContext | undefined;
  pendingTurnInputs: ReadonlyArray<PiPendingTurnInput>;
  readonly consumedTurnInputIds: Set<string>;
  activeTurn: PiTurnContext | undefined;
  requestedTerminalState: "interrupted" | undefined;
  compactionItemId: RuntimeItemId | undefined;
  retryItemId: RuntimeItemId | undefined;
  restartRecoveryItemId: RuntimeItemId | undefined;
  restartRecoveryError: string | undefined;
  stopped: boolean;
}

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly config: PiSettings;
  readonly agentDir: string;
  readonly attachmentsDir: string;
  readonly modelRegistry: ModelRegistry;
  readonly modelRuntime: ModelRuntime;
  /** Credential-free fleet, thread, and project context appended to each new Pi session. */
  readonly fleetSessionBootstrapSnapshot?: FleetSessionBootstrapSnapshotProvider;
  /** Test seam; production always uses Pi's in-process createAgentSession. */
  readonly createSession?: typeof createAgentSession;
  /** Direct adapter unit tests can intentionally exercise Pi without ProviderService MCP wiring. */
  readonly allowMissingMcpForTests?: boolean;
  /** Maximum time to wait for Pi's active run to acknowledge shutdown. */
  readonly stopGraceMs?: number;
}

const DEFAULT_STOP_GRACE_MS = 1_000;

const nowIso = (): string => new Date().toISOString();
const eventId = (): EventId => EventId.make(NodeCrypto.randomUUID());
const turnId = (): TurnId => TurnId.make(NodeCrypto.randomUUID());
const itemId = (value?: string): RuntimeItemId =>
  RuntimeItemId.make(value ?? NodeCrypto.randomUUID());
const requestId = (): ApprovalRequestId => ApprovalRequestId.make(NodeCrypto.randomUUID());

function isAdapterError(cause: unknown): cause is ProviderAdapterError {
  if (!cause || typeof cause !== "object") return false;
  const tag = (cause as { readonly _tag?: unknown })._tag;
  return (
    tag === "ProviderAdapterValidationError" ||
    tag === "ProviderAdapterSessionNotFoundError" ||
    tag === "ProviderAdapterSessionClosedError" ||
    tag === "ProviderAdapterRequestError" ||
    tag === "ProviderAdapterProcessError"
  );
}

function readResumeCursor(value: unknown): PiResumeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionFile !== "string" || typeof record.sessionId !== "string") {
    return undefined;
  }
  const attachedRecord =
    record.attached && typeof record.attached === "object" && !Array.isArray(record.attached)
      ? (record.attached as Record<string, unknown>)
      : undefined;
  const attached =
    attachedRecord &&
    typeof attachedRecord.parentThreadId === "string" &&
    typeof attachedRecord.agentRunId === "string" &&
    typeof attachedRecord.depth === "number"
      ? {
          parentThreadId: attachedRecord.parentThreadId,
          agentRunId: attachedRecord.agentRunId,
          depth: attachedRecord.depth,
        }
      : undefined;
  const pendingTurnInputs = Object.hasOwn(record, "pendingTurnInputs")
    ? validatePendingTurnInputs(decodePiPendingTurnInputs(record.pendingTurnInputs))
    : Object.hasOwn(record, "pendingTurnInput")
      ? validatePendingTurnInputs([decodePiPendingTurnInput(record.pendingTurnInput)])
      : undefined;
  return {
    sessionFile: record.sessionFile,
    sessionId: record.sessionId,
    ...(record.fork === true ? { fork: true } : {}),
    ...(typeof record.activeTurnId === "string" && record.activeTurnId.trim().length > 0
      ? { activeTurnId: record.activeTurnId.trim() }
      : {}),
    ...(record.context === "200k" || record.context === "600k" || record.context === "1m"
      ? { context: record.context }
      : {}),
    ...(pendingTurnInputs ? { pendingTurnInputs } : {}),
    ...(attached ? { attached } : {}),
  };
}

function cursorFor(context: PiSessionContext): PiResumeCursor {
  return {
    sessionFile: context.agent.sessionFile ?? "",
    sessionId: context.agent.sessionId,
    ...(context.activeTurn ? { activeTurnId: context.activeTurn.turnId } : {}),
    ...(context.context ? { context: context.context } : {}),
    ...(context.activeTurn && context.pendingTurnInputs.length > 0
      ? { pendingTurnInputs: context.pendingTurnInputs }
      : {}),
    ...(context.currentAgentRunId
      ? {
          attached: {
            parentThreadId: context.parentThreadId,
            agentRunId: context.currentAgentRunId,
            depth: context.depth,
          },
        }
      : {}),
  };
}

function readConsumedTurnInputIds(sessionManager: SessionManager): Set<string> {
  return new Set(
    sessionManager.getBranch().flatMap((entry) => {
      if (
        entry.type !== "custom" ||
        entry.customType !== PI_PENDING_INPUT_CONSUMED_MARKER ||
        !entry.data ||
        typeof entry.data !== "object" ||
        Array.isArray(entry.data)
      ) {
        return [];
      }
      const inputId = (entry.data as Record<string, unknown>).inputId;
      return typeof inputId === "string" ? [inputId] : [];
    }),
  );
}

function markNextTurnInputConsumed(context: PiSessionContext): void {
  const next = context.pendingTurnInputs.find(
    (pending) => !context.consumedTurnInputIds.has(pending.id),
  );
  if (!next) return;
  context.consumedTurnInputIds.add(next.id);
  // AgentSession notifies subscribers immediately before it appends the user
  // message to SessionManager. Defer our correlation marker one microtask so a
  // durable marker can never claim an input was consumed while its user entry
  // is still absent from the append-only transcript.
  queueMicrotask(() => {
    context.agent.sessionManager.appendCustomEntry(PI_PENDING_INPUT_CONSUMED_MARKER, {
      inputId: next.id,
    });
  });
}

export function withPiContextWindow<TApi extends Model<any>>(
  model: TApi,
  context: PiContext | undefined,
): TApi {
  if (context === undefined) return model;
  assertPiContextSupported(model, context);
  const contextWindow = piContextTokens(context);
  return model.contextWindow === contextWindow ? model : { ...model, contextWindow };
}

function interruptedToolCalls(messages: ReadonlyArray<AgentMessage>): ReadonlyArray<ToolCall> {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return [];
  const trailing = messages.slice(assistantIndex + 1);
  if (trailing.some((message) => message.role !== "toolResult")) return [];
  const completed = new Set(
    trailing.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
  );
  const assistant = messages[assistantIndex];
  if (assistant?.role !== "assistant") return [];
  return assistant.content.filter(
    (block): block is ToolCall => block.type === "toolCall" && !completed.has(block.id),
  );
}

/**
 * Pi deliberately omits errored/aborted assistant messages when it converts a
 * durable transcript back into provider input. A process restart can abort an
 * assistant message after a complete tool call was already persisted, though.
 * If Starcode then records the interrupted tool's terminal result, Pi would
 * replay the result without its function call and the Responses API rejects
 * every later turn with "No tool call found for function call output".
 *
 * Treat only complete persisted tool-call messages as tool-use messages during
 * replay. Empty/partial errored assistant messages remain untouched and are
 * still omitted by Pi.
 */
export function repairInterruptedToolCallReplay(
  messages: ReadonlyArray<AgentMessage>,
): ReadonlyArray<AgentMessage> {
  let changed = false;
  const repaired = messages.map((message) => {
    if (
      message.role !== "assistant" ||
      (message.stopReason !== "aborted" && message.stopReason !== "error") ||
      !message.content.some((block) => block.type === "toolCall")
    ) {
      return message;
    }
    changed = true;
    const { errorMessage: _errorMessage, ...assistant } = message;
    return { ...assistant, stopReason: "toolUse" as const } satisfies AssistantMessage;
  });
  return changed ? repaired : messages;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return [value.text];
      if (value.type === "thinking" && typeof value.thinking === "string") return [value.thinking];
      return [];
    })
    .join("\n");
}

function toolItemType(toolName: string) {
  if (toolName === "bash") return "command_execution" as const;
  if (toolName === "read") return "file_read" as const;
  if (toolName === "edit" || toolName === "write") return "file_change" as const;
  if (toolName === "starcode_spawn_agent") return "collab_agent_tool_call" as const;
  return toolName.startsWith("starcode_") || toolName.startsWith("goal_")
    ? ("mcp_tool_call" as const)
    : ("dynamic_tool_call" as const);
}

function toolDetail(toolName: string, args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of ["command", "path", "description", "message", "prompt"]) {
      if (typeof record[key] === "string" && record[key].trim())
        return record[key].trim().slice(0, 500);
    }
  }
  return toolName;
}

function resultOutput(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as Record<string, unknown>).content;
  const text = textFromContent(content);
  return text.length > 0 ? text : undefined;
}

function promptForInput(input: Pick<ProviderSendTurnInput, "input" | "attachments">): string {
  const attachmentNote =
    input.attachments && input.attachments.length > 0
      ? `\n\nStarcode image attachments: ${input.attachments.map((attachment) => attachment.name).join(", ")}`
      : "";
  return `${input.input ?? "Review the attached files."}${attachmentNote}`;
}

function imagesForInput(
  attachmentsDir: string,
  input: Pick<ProviderSendTurnInput, "attachments">,
): ImageContent[] {
  return (input.attachments ?? []).flatMap((attachment) => {
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    return path && NodeFS.existsSync(path)
      ? [
          {
            type: "image" as const,
            data: NodeFS.readFileSync(path).toString("base64"),
            mimeType: attachment.mimeType,
          },
        ]
      : [];
  });
}

function isWriteTool(toolName: string): boolean {
  return (
    toolName === "bash" ||
    toolName === "edit" ||
    toolName === "write" ||
    toolName === "starcode_new_task" ||
    toolName === "starcode_send_task_message" ||
    toolName.startsWith("project_") ||
    toolName === "starcode_spawn_agent" ||
    toolName === "starcode_send_agent_message" ||
    toolName === "starcode_cancel_agent"
  );
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  options: PiAdapterOptions,
): Effect.fn.Return<ProviderAdapterShape<ProviderAdapterError>> {
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiSessionContext>();

  const emit = (event: ProviderRuntimeEvent): void => {
    // Lifecycle order is part of the provider contract. Forking each offer
    // independently lets `turn.completed` overtake earlier terminal tool
    // events; attached-agent coordination then closes the AgentRun and drops
    // those late events, leaving visibly "Running" tools in a completed agent.
    Queue.offerUnsafe(events, event);
  };

  const baseEvent = (context: PiSessionContext) => ({
    eventId: eventId(),
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    threadId: context.session.threadId,
    createdAt: nowIso(),
  });

  const requireSession = (threadIdValue: ThreadId): PiSessionContext => {
    const context = sessions.get(threadIdValue);
    if (!context) {
      throw new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId: threadIdValue,
      });
    }
    if (context.stopped) {
      throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId: threadIdValue });
    }
    return context;
  };

  const updateSession = (context: PiSessionContext, patch: Partial<ProviderSession>): void => {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: nowIso(),
      resumeCursor: cursorFor(context),
    };
  };

  const closeTurn = (context: PiSessionContext, state: "completed" | "failed" | "interrupted") => {
    const turn = context.activeTurn;
    if (!turn || turn.completed) return;
    turn.completed = true;
    for (const id of turn.messageItems.values()) {
      emit({
        ...baseEvent(context),
        type: "item.completed",
        turnId: turn.turnId,
        itemId: id,
        payload: {
          itemType: "assistant_message",
          status: state === "completed" ? "completed" : "failed",
          title: "Pi response",
          output:
            state === "completed"
              ? "Pi completed without textual output."
              : `Pi response ${state}.`,
        },
      });
    }
    turn.messageItems.clear();
    for (const tool of turn.toolItems.values()) {
      emit({
        ...baseEvent(context),
        type: "item.completed",
        turnId: turn.turnId,
        itemId: tool.itemId,
        payload: {
          itemType: "dynamic_tool_call",
          status: "failed",
          title: tool.toolName,
          detail: toolDetail(tool.toolName, tool.args),
          output: `Tool ${state} before producing a terminal result.`,
          data: { toolName: tool.toolName, input: tool.args },
        },
      });
    }
    turn.toolItems.clear();
    if (context.restartRecoveryItemId) {
      emit({
        ...baseEvent(context),
        type: "item.completed",
        turnId: turn.turnId,
        itemId: context.restartRecoveryItemId,
        payload: {
          itemType: "reasoning",
          status:
            state === "completed" ? "completed" : state === "interrupted" ? "stopped" : "failed",
          title:
            state === "completed"
              ? "Pi turn recovered after restart"
              : state === "interrupted"
                ? "Pi restart recovery stopped"
                : "Pi restart recovery failed",
          output:
            state === "completed"
              ? "Pi continued and completed the same Starcode turn after the server restart."
              : state === "interrupted"
                ? "The recovered Pi turn was cancelled before completion."
                : context.restartRecoveryError ||
                  context.agent.state.errorMessage ||
                  "Pi could not complete the recovered turn after the server restart.",
        },
      });
      context.restartRecoveryItemId = undefined;
      context.restartRecoveryError = undefined;
    }
    const stats = context.agent.getSessionStats();
    const usage = {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      totalTokens: stats.tokens.total,
      cost: stats.cost,
    };
    emit({
      ...baseEvent(context),
      type: "thread.token-usage.updated",
      turnId: turn.turnId,
      payload: {
        usage: {
          usedTokens: stats.contextUsage?.tokens ?? stats.tokens.total,
          totalProcessedTokens: stats.tokens.total,
          maxTokens: stats.contextUsage?.contextWindow,
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          cachedInputTokens: stats.tokens.cacheRead,
          durationMs: Date.now() - turn.startedAt,
          compactsAutomatically: context.agent.autoCompactionEnabled,
        },
      },
    });
    emit({
      ...baseEvent(context),
      type: "turn.completed",
      turnId: turn.turnId,
      payload: {
        state,
        usage,
        totalCostUsd: stats.cost,
        ...(state === "failed" && context.agent.state.errorMessage
          ? { errorMessage: context.agent.state.errorMessage }
          : {}),
      },
    });
    context.turns.push({ id: turn.turnId, items: [...turn.items] });
    context.activeTurn = undefined;
    context.pendingTurnInputs = [];
    context.consumedTurnInputIds.clear();
    context.requestedTerminalState = undefined;
    updateSession(context, { status: "ready", activeTurnId: undefined });
    emit({
      ...baseEvent(context),
      type: "session.state.changed",
      payload: { state: "ready" },
    });
  };

  const handleAgentEvent = (context: PiSessionContext, event: AgentSessionEvent): void => {
    const turn = context.activeTurn;
    switch (event.type) {
      case "message_start": {
        // Pi emits an assistant message for tool-only model turns. Do not open
        // a synthetic response card until text or reasoning actually streams:
        // the tool call has its own independently observable lifecycle.
        break;
      }
      case "message_update": {
        if (!turn) break;
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta" && update.type !== "thinking_delta") break;
        let id = turn.messageItems.get(update.contentIndex);
        if (!id) {
          id = itemId();
          turn.messageItems.set(update.contentIndex, id);
          emit({
            ...baseEvent(context),
            type: "item.started",
            turnId: turn.turnId,
            itemId: id,
            payload: {
              itemType: update.type === "thinking_delta" ? "reasoning" : "assistant_message",
              status: "inProgress",
              title: update.type === "thinking_delta" ? "Pi reasoning" : "Pi response",
            },
          });
        }
        emit({
          ...baseEvent(context),
          type: "content.delta",
          turnId: turn.turnId,
          itemId: id,
          payload: {
            streamKind: update.type === "thinking_delta" ? "reasoning_text" : "assistant_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
        });
        break;
      }
      case "message_end": {
        if (!turn) break;
        if (event.message.role === "user") {
          markNextTurnInputConsumed(context);
          break;
        }
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        for (const [index, id] of turn.messageItems) {
          const block = message.content[index];
          const reasoning = block?.type === "thinking";
          emit({
            ...baseEvent(context),
            type: "item.completed",
            turnId: turn.turnId,
            itemId: id,
            payload: {
              itemType: reasoning ? "reasoning" : "assistant_message",
              status: message.stopReason === "error" ? "failed" : "completed",
              title: reasoning ? "Pi reasoning" : "Pi response",
              output:
                (block ? textFromContent([block]) : "") ||
                (message.stopReason === "error"
                  ? message.errorMessage || "Pi failed without textual output."
                  : "Pi completed without textual output."),
            },
          });
        }
        turn.messageItems.clear();
        turn.items.push(message);
        break;
      }
      case "tool_execution_start": {
        if (!turn) break;
        const id = itemId(event.toolCallId);
        turn.toolItems.set(event.toolCallId, {
          itemId: id,
          toolName: event.toolName,
          args: event.args,
        });
        emit({
          ...baseEvent(context),
          type: "item.started",
          turnId: turn.turnId,
          itemId: id,
          payload: {
            itemType: toolItemType(event.toolName),
            status: "inProgress",
            title: event.toolName,
            detail: toolDetail(event.toolName, event.args),
            data: { toolName: event.toolName, input: event.args },
          },
        });
        break;
      }
      case "tool_execution_update": {
        if (!turn) break;
        const tool = turn.toolItems.get(event.toolCallId);
        if (!tool) break;
        emit({
          ...baseEvent(context),
          type: "item.updated",
          turnId: turn.turnId,
          itemId: tool.itemId,
          payload: {
            itemType: toolItemType(event.toolName),
            status: "inProgress",
            title: event.toolName,
            detail: toolDetail(event.toolName, event.args),
            data: { toolName: event.toolName, input: event.args },
            ...(resultOutput(event.partialResult)
              ? { output: resultOutput(event.partialResult) }
              : {}),
          },
        });
        break;
      }
      case "tool_execution_end": {
        if (!turn) break;
        const tool = turn.toolItems.get(event.toolCallId);
        const id = tool?.itemId ?? itemId(event.toolCallId);
        const args = tool?.args;
        const stopped = context.requestedTerminalState === "interrupted";
        emit({
          ...baseEvent(context),
          type: "item.completed",
          turnId: turn.turnId,
          itemId: id,
          payload: {
            itemType: toolItemType(event.toolName),
            status: stopped ? "stopped" : event.isError ? "failed" : "completed",
            title: event.toolName,
            detail: toolDetail(event.toolName, args),
            output:
              resultOutput(event.result) ??
              (event.isError
                ? "Tool failed without textual error output."
                : "Tool completed successfully without textual output."),
            data: { toolName: event.toolName, input: args, result: event.result },
          },
        });
        turn.items.push(event.result);
        turn.toolItems.delete(event.toolCallId);
        break;
      }
      case "compaction_start":
        context.compactionItemId = itemId();
        emit({
          ...baseEvent(context),
          type: "item.started",
          ...(turn ? { turnId: turn.turnId } : {}),
          itemId: context.compactionItemId,
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Pi context compaction",
            detail: event.reason,
          },
        });
        emit({
          ...baseEvent(context),
          type: "thread.state.changed",
          ...(turn ? { turnId: turn.turnId } : {}),
          payload: { state: "active", detail: { compaction: "started", reason: event.reason } },
        });
        break;
      case "compaction_end":
        emit({
          ...baseEvent(context),
          type: "item.completed",
          ...(turn ? { turnId: turn.turnId } : {}),
          itemId: context.compactionItemId ?? itemId(),
          payload: {
            itemType: "context_compaction",
            status: event.aborted || !event.result ? "failed" : "completed",
            title: "Pi context compaction",
            detail: event.reason,
            output:
              event.errorMessage ??
              (event.aborted
                ? "Compaction was cancelled."
                : event.result
                  ? "Context compacted successfully."
                  : "Compaction ended without a result."),
          },
        });
        context.compactionItemId = undefined;
        emit({
          ...baseEvent(context),
          type: "thread.state.changed",
          ...(turn ? { turnId: turn.turnId } : {}),
          payload: {
            state: event.aborted || !event.result ? "active" : "compacted",
            detail: {
              reason: event.reason,
              aborted: event.aborted,
              willRetry: event.willRetry,
              ...(event.errorMessage ? { error: event.errorMessage } : {}),
            },
          },
        });
        break;
      case "auto_retry_start": {
        const retryId = context.retryItemId ?? itemId();
        const firstAttempt = context.retryItemId === undefined;
        context.retryItemId = retryId;
        emit({
          ...baseEvent(context),
          type: firstAttempt ? "item.started" : "item.updated",
          ...(turn ? { turnId: turn.turnId } : {}),
          itemId: retryId,
          payload: {
            itemType: "reasoning",
            status: "inProgress",
            title: "Recovering Pi connection",
            detail: `Attempt ${event.attempt} of ${event.maxAttempts} in ${event.delayMs}ms`,
            output: event.errorMessage,
          },
        });
        emit({
          ...baseEvent(context),
          type: "thread.state.changed",
          ...(turn ? { turnId: turn.turnId } : {}),
          payload: {
            state: "active",
            detail: {
              recovery: "retrying",
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              error: event.errorMessage,
            },
          },
        });
        break;
      }
      case "auto_retry_end": {
        const interrupted = context.requestedTerminalState === "interrupted";
        emit({
          ...baseEvent(context),
          type: "item.completed",
          ...(turn ? { turnId: turn.turnId } : {}),
          itemId: context.retryItemId ?? itemId(),
          payload: {
            itemType: "reasoning",
            status: interrupted ? "stopped" : event.success ? "completed" : "failed",
            title: interrupted
              ? "Pi connection recovery stopped"
              : event.success
                ? "Pi connection recovered"
                : "Pi connection recovery failed",
            detail: `${event.attempt} ${event.attempt === 1 ? "attempt" : "attempts"}`,
            output: interrupted
              ? "Pi connection recovery was cancelled with the active turn."
              : event.success
                ? "Pi resumed the same turn after a transient provider connection failure."
                : event.finalError || "Pi exhausted its connection recovery attempts.",
          },
        });
        context.retryItemId = undefined;
        if (turn && !turn.completed) {
          closeTurn(context, interrupted ? "interrupted" : event.success ? "completed" : "failed");
        }
        break;
      }
      case "agent_end":
        // AgentSession creates its retry promise synchronously before publishing
        // agent_end. Pi 0.83 also marks the pre-backoff event with `willRetry`,
        // before `isRetrying` becomes observable. Keep the Starcode turn and
        // attached AgentRun alive; auto_retry_end owns the terminal event.
        if (event.willRetry || context.agent.isRetrying || context.retryItemId !== undefined) break;
        closeTurn(
          context,
          context.requestedTerminalState ??
            (context.agent.state.errorMessage ? "failed" : "completed"),
        );
        break;
      default:
        break;
    }
  };

  const installPermissionHook = (context: PiSessionContext): void => {
    context.agent.agent.beforeToolCall = async (call: BeforeToolCallContext) => {
      const toolName = call.toolCall.name;
      if (!isWriteTool(toolName)) return undefined;
      if (context.sandboxMode === "read-only") {
        return { block: true, reason: `Tool '${toolName}' is blocked by Starcode read-only mode.` };
      }
      if (context.acceptedTools.has(toolName)) return undefined;
      if (context.approvalPolicy === "never" || context.session.runtimeMode === "full-access") {
        return undefined;
      }
      if (
        context.session.runtimeMode === "auto-accept-edits" &&
        (toolName === "edit" || toolName === "write")
      ) {
        return undefined;
      }

      const id = requestId();
      const detail = `${toolName}: ${toolDetail(toolName, call.args)}`;
      const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
        context.pendingApprovals.set(id, {
          requestId: id,
          toolName,
          detail,
          args: call.args,
          resolve,
        });
        emit({
          ...baseEvent(context),
          type: "request.opened",
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          requestId: RuntimeRequestId.make(id),
          payload: {
            requestType:
              toolName === "bash"
                ? "command_execution_approval"
                : toolName === "edit" || toolName === "write"
                  ? "file_change_approval"
                  : "dynamic_tool_call",
            detail,
            args: call.args,
          },
        });
      });
      context.pendingApprovals.delete(id);
      emit({
        ...baseEvent(context),
        type: "request.resolved",
        ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
        requestId: RuntimeRequestId.make(id),
        payload: {
          requestType:
            toolName === "bash"
              ? "command_execution_approval"
              : toolName === "edit" || toolName === "write"
                ? "file_change_approval"
                : "dynamic_tool_call",
          decision,
          detail,
          args: call.args,
        },
      });
      if (decision === "acceptForSession") context.acceptedTools.add(toolName);
      return decision === "accept" || decision === "acceptForSession"
        ? undefined
        : { block: true, reason: `Starcode declined '${toolName}'.` };
    };
  };

  const startSessionWithBootstrap = (
    input: ProviderSessionStartInput,
    fleetSessionBootstrapInstructions: string | undefined,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) return existing.session;
        const cwd = input.cwd ?? process.cwd();
        const resume = readResumeCursor(input.resumeCursor);
        // Forks are new top-level sessions. They copy transcript history but
        // never inherit a source turn's active state or attached attribution.
        const resumeAttached = resume?.fork ? undefined : resume?.attached;
        const recoveredTurnId = resume?.fork
          ? undefined
          : (input.activeTurnId ??
            (resume?.activeTurnId ? TurnId.make(resume.activeTurnId) : undefined));
        const parentThreadId = resumeAttached
          ? ThreadId.make(resumeAttached.parentThreadId)
          : input.threadId;
        const sessionDirectory = NodePath.join(options.agentDir, "sessions", input.threadId);
        const sessionManager = (() => {
          if (resume?.fork) {
            if (!resume.sessionFile.trim() || !NodeFS.existsSync(resume.sessionFile)) {
              throw new Error(
                `Cannot fork Pi session: source transcript '${resume.sessionFile}' does not exist.`,
              );
            }
            // `forkFrom` validates the JSONL header and history. Never fall
            // back to a blank session when a requested fork cannot be copied.
            return SessionManager.forkFrom(resume.sessionFile, cwd, sessionDirectory);
          }
          return resume?.sessionFile && NodeFS.existsSync(resume.sessionFile)
            ? SessionManager.open(resume.sessionFile, sessionDirectory, cwd)
            : SessionManager.create(cwd, sessionDirectory);
        })();
        const baseModel = resolvePiModel(
          options.modelRegistry,
          input.modelSelection?.model,
          options.config.enabledModels,
        );
        if (!baseModel) {
          throw new Error(
            "Pi has no authenticated model. Add a provider API credential to this Pi instance or complete a supported Pi OAuth login in its data directory.",
          );
        }
        const canonicalModelOptions = canonicalizePiProviderOptions(input.modelSelection?.options);
        const requestedContext = readPiContext(canonicalModelOptions);
        const contextChoice =
          requestedContext ??
          (input.modelSelection?.model ? undefined : resume?.context) ??
          piDefaultContextForModel(baseModel);
        const model = withPiContextWindow(baseModel, contextChoice);
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: true },
          ...(options.config.enabledModels.length > 0
            ? { enabledModels: [...options.config.enabledModels] }
            : {}),
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir: options.agentDir,
          settingsManager,
          noExtensions: !options.config.allowProjectExtensions,
          additionalExtensionPaths: [...options.config.trustedExtensionPaths],
          appendSystemPrompt: [
            STARCODE_PI_INSTRUCTIONS,
            ...(fleetSessionBootstrapInstructions ? [fleetSessionBootstrapInstructions] : []),
          ],
          noThemes: true,
        });
        await resourceLoader.reload();
        const mcpConfig = McpProviderSession.readMcpProviderSession(input.threadId);
        if (!mcpConfig && !options.allowMissingMcpForTests) {
          throw new Error(
            "Pi session startup requires an active Starcode MCP credential; ProviderService did not prepare one.",
          );
        }
        const mcpTools = await createPiMcpTools(mcpConfig, signal);
        let context!: PiSessionContext;
        const customTools = [
          ...mcpTools,
          ...createPiAttachedAgentTools({
            parentThreadId,
            ...(resumeAttached ? { currentAgentRunId: resumeAttached.agentRunId } : {}),
            cwd,
            defaultProviderInstanceId: options.instanceId,
            defaultModel: piModelSlug(model),
            defaultOptions: [
              { id: "effort", value: readPiEffort(canonicalModelOptions) ?? "medium" },
              ...(contextChoice ? [{ id: "context", value: contextChoice }] : []),
            ],
            resolveDefaultSelection: () => {
              const currentModel = context.agent.model
                ? piModelSlug(context.agent.model)
                : context.session.model;
              return {
                providerInstanceId: options.instanceId,
                ...(currentModel ? { model: currentModel } : {}),
                options: [
                  { id: "effort", value: context.agent.thinkingLevel },
                  ...(context.context ? [{ id: "context", value: context.context }] : []),
                ],
              };
            },
            depth: resumeAttached?.depth ?? 0,
            maxDepth: options.config.maxAgentDepth,
            maxChildren: options.config.maxAttachedAgents,
          }),
        ];
        const created = await (options.createSession ?? createAgentSession)({
          cwd,
          agentDir: options.agentDir,
          modelRuntime: options.modelRuntime,
          model,
          thinkingLevel: readPiEffort(canonicalModelOptions) ?? "medium",
          sessionManager,
          settingsManager,
          resourceLoader,
          customTools,
        });
        created.session.agent.state.messages = [
          ...repairInterruptedToolCallReplay(created.session.agent.state.messages),
        ];
        const createdAt = nowIso();
        const unsubscribe = created.session.subscribe((event) => handleAgentEvent(context, event));
        context = {
          session: {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: recoveredTurnId ? "running" : "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: piModelSlug(model),
            threadId: input.threadId,
            ...(recoveredTurnId ? { activeTurnId: recoveredTurnId } : {}),
            resumeCursor: {
              sessionFile: created.session.sessionFile ?? "",
              sessionId: created.session.sessionId,
              ...(recoveredTurnId ? { activeTurnId: recoveredTurnId } : {}),
              ...(contextChoice ? { context: contextChoice } : {}),
              ...(recoveredTurnId && resume?.pendingTurnInputs
                ? { pendingTurnInputs: resume.pendingTurnInputs }
                : {}),
              ...(resumeAttached ? { attached: resumeAttached } : {}),
            },
            createdAt,
            updatedAt: createdAt,
          },
          agent: created.session,
          unsubscribe,
          turns: [],
          pendingApprovals: new Map(),
          acceptedTools: new Set(),
          approvalPolicy: input.approvalPolicy,
          sandboxMode: input.sandboxMode,
          parentThreadId,
          ...(resumeAttached ? { currentAgentRunId: resumeAttached.agentRunId } : {}),
          depth: resumeAttached?.depth ?? 0,
          context: contextChoice,
          pendingTurnInputs: recoveredTurnId ? (resume?.pendingTurnInputs ?? []) : [],
          consumedTurnInputIds: readConsumedTurnInputIds(created.session.sessionManager),
          activeTurn: recoveredTurnId
            ? {
                turnId: recoveredTurnId,
                startedAt: Date.now(),
                items: [],
                messageItems: new Map(),
                toolItems: new Map(),
                completed: false,
              }
            : undefined,
          requestedTerminalState: undefined,
          compactionItemId: undefined,
          retryItemId: undefined,
          restartRecoveryItemId: undefined,
          restartRecoveryError: undefined,
          stopped: false,
        };
        sessions.set(input.threadId, context);
        installPermissionHook(context);
        emit({
          ...baseEvent(context),
          type: "session.started",
          payload: { message: "Embedded Pi session started", resume: cursorFor(context) },
        });
        emit({
          ...baseEvent(context),
          type: "thread.started",
          payload: { providerThreadId: created.session.sessionId },
        });
        emit({
          ...baseEvent(context),
          type: "session.state.changed",
          ...(recoveredTurnId ? { turnId: recoveredTurnId } : {}),
          payload: { state: recoveredTurnId ? "running" : "ready" },
        });
        if (recoveredTurnId) {
          const recoveryId = itemId();
          context.restartRecoveryItemId = recoveryId;
          emit({
            ...baseEvent(context),
            type: "item.started",
            turnId: recoveredTurnId,
            itemId: recoveryId,
            payload: {
              itemType: "reasoning",
              status: "inProgress",
              title: "Recovering Pi turn after restart",
              output: "Starcode is rebuilding the same Pi turn from its durable transcript.",
            },
          });
          emit({
            ...baseEvent(context),
            type: "content.delta",
            turnId: recoveredTurnId,
            itemId: recoveryId,
            payload: {
              streamKind: "reasoning_text",
              delta:
                "Recovering the same Pi turn after the Starcode server restart. Interrupted tools will be marked stopped before Pi continues.",
              contentIndex: 0,
            },
          });
          const interrupted = interruptedToolCalls(context.agent.agent.state.messages);
          const recoveredResults: ToolResultMessage[] = interrupted.map((call) => ({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [
              {
                type: "text",
                text: "This tool was interrupted by a Starcode server restart before it produced a terminal result. Inspect current state and rerun it if still needed.",
              },
            ],
            details: { starcodeRecovery: "server-restart" },
            isError: true,
            timestamp: Date.now(),
          }));
          for (let index = 0; index < interrupted.length; index += 1) {
            const call = interrupted[index]!;
            const result = recoveredResults[index]!;
            context.agent.sessionManager.appendMessage(result);
            emit({
              ...baseEvent(context),
              type: "item.completed",
              turnId: recoveredTurnId,
              itemId: itemId(call.id),
              payload: {
                itemType: toolItemType(call.name),
                status: "stopped",
                title: call.name,
                detail: toolDetail(call.name, call.arguments),
                output:
                  "Tool stopped because the Starcode server restarted before a result was recorded. Pi will inspect state and rerun it if needed.",
                data: { toolName: call.name, input: call.arguments, result },
              },
            });
          }
          if (recoveredResults.length > 0) {
            context.agent.agent.state.messages = [
              ...context.agent.agent.state.messages,
              ...recoveredResults,
            ];
          }
          let consumedPrefixLength = 0;
          while (
            context.pendingTurnInputs[consumedPrefixLength] &&
            context.consumedTurnInputIds.has(context.pendingTurnInputs[consumedPrefixLength]!.id)
          ) {
            consumedPrefixLength += 1;
          }
          const recoveryValidationError = context.pendingTurnInputs
            .slice(consumedPrefixLength)
            .some((pending) => context.consumedTurnInputIds.has(pending.id))
            ? "The recovered Pi transcript contains an out-of-order pending-input marker."
            : undefined;
          const remainingPending = context.pendingTurnInputs.slice(consumedPrefixLength);
          const lastMessage = context.agent.agent.state.messages.at(-1);
          const failRestartRecovery = (cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            context.restartRecoveryError = message;
            emit({
              ...baseEvent(context),
              type: "runtime.error",
              turnId: recoveredTurnId,
              payload: {
                class: "provider_error",
                message,
              },
            });
            closeTurn(context, "failed");
          };
          if (recoveryValidationError) {
            failRestartRecovery(recoveryValidationError);
          } else if (lastMessage?.role === "assistant" && remainingPending.length === 0) {
            closeTurn(
              context,
              lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted"
                ? "failed"
                : "completed",
            );
          } else if (!lastMessage && remainingPending.length === 0) {
            failRestartRecovery(
              "The persisted Pi transcript and durable pending input are empty; the interrupted turn cannot be resumed.",
            );
          } else {
            let markRunStarted!: () => void;
            const runStarted = new Promise<void>((resolve) => {
              markRunStarted = resolve;
            });
            const unsubscribeStart = context.agent.subscribe((event) => {
              if (event.type === "agent_start") {
                unsubscribeStart();
                markRunStarted();
              }
            });
            const [firstPending, ...pendingSteering] = remainingPending;
            const startsWithPendingInput = !lastMessage || lastMessage.role === "assistant";
            const firstImages = firstPending
              ? imagesForInput(options.attachmentsDir, firstPending)
              : [];
            const run = startsWithPendingInput
              ? context.agent.prompt(
                  promptForInput(firstPending!),
                  firstImages.length > 0 ? { images: firstImages } : undefined,
                )
              : context.agent.agent.continue();
            const steering = startsWithPendingInput ? pendingSteering : remainingPending;
            void (async () => {
              await Promise.race([runStarted, run]);
              for (const pending of steering) {
                const prompt = promptForInput(pending);
                const images = imagesForInput(options.attachmentsDir, pending);
                await context.agent.prompt(prompt, {
                  streamingBehavior: "steer",
                  ...(images.length > 0 ? { images } : {}),
                });
              }
              await run;
            })().catch((cause) => {
              unsubscribeStart();
              failRestartRecovery(cause);
            });
          }
        }
        return context.session;
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "startSession",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    resolveFleetSessionBootstrapInstructions(options.fleetSessionBootstrapSnapshot, {
      threadId: input.threadId,
    }).pipe(
      Effect.flatMap((fleetSessionBootstrapInstructions) =>
        startSessionWithBootstrap(input, fleetSessionBootstrapInstructions),
      ),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.try({
      try: () => {
        const context = requireSession(input.threadId);
        if (!input.input && (!input.attachments || input.attachments.length === 0)) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi requires text or an attachment.",
          });
        }
        const requestedModel = input.modelSelection?.model;
        const requestedContext = readPiContext(input.modelSelection?.options);
        if (requestedModel || requestedContext !== undefined) {
          const selected = requestedModel
            ? resolvePiModel(options.modelRegistry, requestedModel, options.config.enabledModels)
            : context.agent.model;
          if (!selected) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Pi model '${requestedModel ?? "current"}' is unavailable or unauthenticated.`,
            });
          }
          const selectedContext =
            requestedContext ??
            (requestedModel ? piDefaultContextForModel(selected) : context.context);
          const effectiveModel = withPiContextWindow(selected, selectedContext);
          if (
            piModelSlug(context.agent.model!) !== piModelSlug(effectiveModel) ||
            context.agent.model?.contextWindow !== effectiveModel.contextWindow
          ) {
            void context.agent.setModel(effectiveModel);
          }
          context.context = selectedContext;
        }
        const effort = readPiEffort(input.modelSelection?.options);
        if (effort !== undefined) context.agent.setThinkingLevel(effort);
        const pendingTurnInput = {
          id: NodeCrypto.randomUUID(),
          ...(input.input ? { input: input.input } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        } satisfies PiPendingTurnInput;
        const prompt = promptForInput(pendingTurnInput);
        context.agent.agent.state.messages = [
          ...repairInterruptedToolCallReplay(context.agent.agent.state.messages),
        ];
        const images = imagesForInput(options.attachmentsDir, pendingTurnInput);
        if (context.agent.isStreaming && context.activeTurn) {
          context.pendingTurnInputs = validatePendingTurnInputs([
            ...context.pendingTurnInputs,
            pendingTurnInput,
          ]);
          updateSession(context, {});
          void context.agent.prompt(prompt, {
            streamingBehavior: "steer",
            ...(images.length > 0 ? { images } : {}),
          });
          return {
            threadId: input.threadId,
            turnId: context.activeTurn.turnId,
            resumeCursor: cursorFor(context),
          };
        }
        const id = turnId();
        context.activeTurn = {
          turnId: id,
          startedAt: Date.now(),
          items: [],
          messageItems: new Map(),
          toolItems: new Map(),
          completed: false,
        };
        context.pendingTurnInputs = validatePendingTurnInputs([pendingTurnInput]);
        updateSession(context, { status: "running", activeTurnId: id });
        emit({
          ...baseEvent(context),
          type: "turn.started",
          turnId: id,
          payload: {
            model: context.agent.model ? piModelSlug(context.agent.model) : context.session.model,
            effort: context.agent.thinkingLevel,
          },
        });
        if (context.currentAgentRunId) {
          emit({
            ...baseEvent(context),
            type: "item.completed",
            turnId: id,
            itemId: itemId(),
            payload: {
              itemType: "user_message",
              status: "completed",
              title: "You",
              output: prompt,
            },
          });
        }
        emit({
          ...baseEvent(context),
          type: "session.state.changed",
          turnId: id,
          payload: { state: "running" },
        });
        void context.agent
          .prompt(prompt, images.length > 0 ? { images } : undefined)
          .catch((cause) => {
            emit({
              ...baseEvent(context),
              type: "runtime.error",
              turnId: id,
              payload: {
                class: "provider_error",
                message: cause instanceof Error ? cause.message : String(cause),
              },
            });
            closeTurn(context, "failed");
          });
        return { threadId: input.threadId, turnId: id, resumeCursor: cursorFor(context) };
      },
      catch: (cause) =>
        isAdapterError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadIdValue,
    requestedTurnId,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const context = requireSession(threadIdValue);
        if (requestedTurnId && context.activeTurn?.turnId !== requestedTurnId) return;
        context.requestedTerminalState = "interrupted";
        await context.agent.abort();
        closeTurn(context, "interrupted");
      },
      catch: (cause) =>
        isAdapterError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "interruptTurn",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadIdValue) =>
    Effect.gen(function* () {
      const context = yield* Effect.try({
        try: () => requireSession(threadIdValue),
        catch: (cause) =>
          isAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "stopSession",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      });
      context.requestedTerminalState = "interrupted";
      yield* Effect.tryPromise({
        try: () => context.agent.abort(),
        catch: (cause) =>
          isAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "stopSession",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(
        Effect.timeoutOption(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            context.unsubscribe();
            context.agent.dispose();
            context.stopped = true;
            for (const approval of context.pendingApprovals.values()) approval.resolve("cancel");
            context.pendingApprovals.clear();
            closeTurn(context, "interrupted");
            updateSession(context, { status: "closed", activeTurnId: undefined });
            emit({
              ...baseEvent(context),
              type: "session.exited",
              payload: { exitKind: "graceful", recoverable: true, reason: "Stopped by Starcode" },
            });
          }),
        ),
      );
    });

  const shutdownSession = (context: PiSessionContext) =>
    Effect.gen(function* () {
      // ProviderService snapshots the live session before calling stopAll so it
      // can resume the same Pi process state on the next boot. Unsubscribe
      // before aborting: Pi's abort/dispose notifications are process-cleanup
      // details, not user-requested lifecycle transitions, and publishing them
      // would overwrite that durable snapshot with `stopped`.
      context.unsubscribe();
      context.requestedTerminalState = "interrupted";
      yield* Effect.tryPromise({
        try: () => context.agent.abort(),
        catch: (cause) =>
          isAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "stopAll",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(
        Effect.timeoutOption(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            context.agent.dispose();
            context.stopped = true;
            for (const approval of context.pendingApprovals.values()) approval.resolve("cancel");
            context.pendingApprovals.clear();
          }),
        ),
      );
    });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", goalControl: "managed" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: (threadIdValue, approvalId, decision) =>
      Effect.try({
        try: () => {
          const context = requireSession(threadIdValue);
          const pending = context.pendingApprovals.get(approvalId);
          if (!pending) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToRequest",
              issue: `Unknown Pi approval '${approvalId}'.`,
            });
          }
          pending.resolve(decision);
        },
        catch: (cause) =>
          isAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToRequest",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }),
    respondToUserInput: (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: "Pi has no pending structured input request.",
        }),
      ),
    stopSession,
    listSessions: () => Effect.succeed(Array.from(sessions.values(), (context) => context.session)),
    hasSession: (threadIdValue) =>
      Effect.succeed(sessions.has(threadIdValue) && !sessions.get(threadIdValue)!.stopped),
    readThread: (threadIdValue) =>
      Effect.try({
        try: () => {
          const context = requireSession(threadIdValue);
          return { threadId: threadIdValue, turns: [...context.turns] };
        },
        catch: (cause) =>
          isAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "readThread",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }),
    rollbackThread: (threadIdValue, numTurns) =>
      Effect.try({
        try: () => {
          const context = requireSession(threadIdValue);
          const messages = context.agent.getUserMessagesForForking();
          const keepIndex = Math.max(0, messages.length - numTurns - 1);
          const target = messages[keepIndex];
          if (target) context.agent.sessionManager.branch(target.entryId);
          context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
          updateSession(context, {});
          return { threadId: threadIdValue, turns: [...context.turns] };
        },
        catch: (cause) =>
          isAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "rollbackThread",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }),
    stopAll: () =>
      Effect.forEach(
        Array.from(sessions.values()).filter((context) => !context.stopped),
        (context) => shutdownSession(context).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      ),
    streamEvents: Stream.fromQueue(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
