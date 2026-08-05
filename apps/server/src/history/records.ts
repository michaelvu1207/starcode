/**
 * Terminal history - rendering CLI session records.
 *
 * Pure and total. Every function here takes an already-parsed jsonl record of
 * unknown shape and either returns something renderable or returns null; none
 * of them throw, because a single malformed or unrecognised line in a 38 MB
 * log must never fail the page it appears in.
 *
 * The rendering is deliberately lossy, matching `peers/transcript.ts`: roles,
 * message text clipped to a budget, and tool-call *names*. Tool payloads,
 * reasoning traces, file snapshots, and base64 images are dropped entirely.
 * That is what keeps a preview bounded no matter what the session did.
 *
 * @module HistoryRecords
 */
import {
  HISTORY_SNIPPET_MAX_CHARS,
  HISTORY_TRANSCRIPT_ENTRY_MAX_CHARS,
  HISTORY_TRANSCRIPT_MAX_TOOL_CALLS,
  type HistoryProvider,
  type HistoryTranscriptEntry,
} from "@starcode/contracts";

const TOOL_CALL_NAME_MAX_CHARS = 80;

const clip = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;

/** Collapses the whitespace a multi-line prompt carries into a one-line label. */
const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Parses one line, returning null rather than throwing.
 *
 * Truncated trailing lines are normal: a session being written to right now
 * ends mid-record, and the tail reader starts at an arbitrary byte offset.
 */
export const parseRecord = (line: string): Record<string, unknown> | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

interface RenderedRecord {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolCalls: ReadonlyArray<string>;
  readonly timestamp: string | null;
  /**
   * True when this record is something a human typed, as opposed to a tool
   * result or an injected context block wearing the user role. Only these are
   * eligible to be a listing snippet.
   */
  readonly isHumanTurn: boolean;
}

/**
 * Text and tool names from a Claude content array.
 *
 * Claude puts four kinds of block in here and only two survive: `text` becomes
 * the message, `tool_use` contributes its name. `thinking` is dropped because
 * it is long, signed, and not what a preview is for; `tool_result` and `image`
 * are dropped because they are payloads.
 */
const readClaudeContent = (
  content: unknown,
): {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<string>;
  readonly hasResult: boolean;
} => {
  if (typeof content === "string") return { text: content, toolCalls: [], hasResult: false };
  if (!Array.isArray(content)) return { text: "", toolCalls: [], hasResult: false };

  const texts: string[] = [];
  const toolCalls: string[] = [];
  let hasResult = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const kind = block["type"];
    if (kind === "text") {
      const text = asString(block["text"]);
      if (text !== null) texts.push(text);
      continue;
    }
    if (kind === "tool_use") {
      const name = asString(block["name"]);
      if (name !== null && toolCalls.length < HISTORY_TRANSCRIPT_MAX_TOOL_CALLS) {
        toolCalls.push(clip(name, TOOL_CALL_NAME_MAX_CHARS));
      }
      continue;
    }
    if (kind === "tool_result") hasResult = true;
  }
  return { text: texts.join("\n\n"), toolCalls, hasResult };
};

/**
 * Renders a Claude Code record.
 *
 * The store holds a dozen bookkeeping types — `last-prompt`, `agent-setting`,
 * `mode`, `attachment`, `queue-operation`, `file-history-snapshot` and more —
 * that carry no conversation. Only `user` and `assistant` are rendered, and a
 * `user` record whose content is nothing but tool results is dropped too: it is
 * the transport for a tool's output, not a turn anyone took.
 */
const renderClaudeRecord = (record: Record<string, unknown>): RenderedRecord | null => {
  const kind = record["type"];
  if (kind !== "user" && kind !== "assistant") return null;

  const message = record["message"];
  if (!isRecord(message)) return null;
  const { text, toolCalls, hasResult } = readClaudeContent(message["content"]);
  if (text.length === 0 && toolCalls.length === 0) return null;

  const isSidechain = record["isSidechain"] === true;
  return {
    role: kind,
    text,
    toolCalls,
    timestamp: asString(record["timestamp"]),
    // A tool-result carrier, a subagent's own thread, and an assistant turn
    // are all real transcript entries but none of them is the prompt a listing
    // row should show.
    isHumanTurn: kind === "user" && !hasResult && !isSidechain && text.length > 0,
  };
};

/**
 * Tool name from a Codex `response_item`.
 *
 * Codex spells tool calls four ways depending on version and tool kind, and
 * each puts the name somewhere slightly different.
 */
const codexToolCallName = (
  payloadType: string,
  payload: Record<string, unknown>,
): string | null => {
  switch (payloadType) {
    case "function_call":
    case "custom_tool_call":
      return asString(payload["name"]);
    case "local_shell_call":
      return "shell";
    case "web_search_call":
      return "web_search";
    default:
      return null;
  }
};

/**
 * Renders a Codex rollout record.
 *
 * Codex logs each turn twice: once as an `event_msg` and once as a
 * `response_item`. We render only `event_msg`, because `response_item`
 * additionally carries the developer preamble, the AGENTS.md injection, and
 * the environment context as `user`-role messages — tens of kilobytes of
 * scaffolding that would drown the actual conversation. `event_msg` has been
 * present in every rollout version in the store, back to the 2025 files.
 */
const renderCodexRecord = (record: Record<string, unknown>): RenderedRecord | null => {
  const payload = record["payload"];
  if (!isRecord(payload)) return null;
  const payloadType = asString(payload["type"]);
  if (payloadType === null) return null;
  const timestamp = asString(record["timestamp"]);

  if (record["type"] === "event_msg") {
    if (payloadType === "user_message" || payloadType === "agent_message") {
      const text = asString(payload["message"]);
      if (text === null) return null;
      const role = payloadType === "user_message" ? "user" : "assistant";
      return { role, text, toolCalls: [], timestamp, isHumanTurn: role === "user" };
    }
    return null;
  }

  if (record["type"] === "response_item") {
    const name = codexToolCallName(payloadType, payload);
    if (name === null) return null;
    return {
      role: "assistant",
      text: "",
      toolCalls: [clip(name, TOOL_CALL_NAME_MAX_CHARS)],
      timestamp,
      isHumanTurn: false,
    };
  }

  return null;
};

export const renderRecord = (
  provider: HistoryProvider,
  record: Record<string, unknown>,
): RenderedRecord | null =>
  provider === "claude" ? renderClaudeRecord(record) : renderCodexRecord(record);

/** Record types that can produce a transcript entry, by provider. */
const RENDERABLE_CLAUDE_TYPES = new Set(["user", "assistant"]);
const RENDERABLE_CODEX_PAYLOAD_TYPES = new Set([
  "user_message",
  "agent_message",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
]);

const TYPE_PATTERN = /"type"\s*:\s*"([A-Za-z0-9_-]+)"/;
const PAYLOAD_TYPE_PATTERN = /"payload"\s*:\s*\{\s*"type"\s*:\s*"([A-Za-z0-9_-]+)"/;

/**
 * Decides from a record's opening bytes whether it is worth decoding in full.
 *
 * This exists for one shape the local store really contains: a Codex session
 * whose records are 3.5 MB of base64 image data each. Both providers put the
 * discriminating `type` within the first few hundred bytes, so an oversized
 * record can be dismissed without ever materialising it as a string — which
 * turns skipping a megabyte-scale record from an allocation into a regex.
 *
 * Conservative by construction: it only ever answers "definitely not
 * renderable". Anything it is unsure about is decoded normally.
 */
export const isDefinitelyUnrenderable = (provider: HistoryProvider, head: string): boolean => {
  const type = TYPE_PATTERN.exec(head)?.[1];
  if (type === undefined) return false;
  if (provider === "claude") return !RENDERABLE_CLAUDE_TYPES.has(type);
  if (type !== "event_msg" && type !== "response_item") return true;
  const payloadType = PAYLOAD_TYPE_PATTERN.exec(head)?.[1];
  return payloadType !== undefined && !RENDERABLE_CODEX_PAYLOAD_TYPES.has(payloadType);
};

/** A rendered record placed at its byte offset in the file. */
export const toTranscriptEntry = (
  offset: number,
  rendered: RenderedRecord,
): HistoryTranscriptEntry => ({
  offset,
  role: rendered.role,
  text: clip(rendered.text, HISTORY_TRANSCRIPT_ENTRY_MAX_CHARS),
  truncated: rendered.text.length > HISTORY_TRANSCRIPT_ENTRY_MAX_CHARS,
  toolCalls: rendered.toolCalls,
  timestamp: rendered.timestamp,
});

/**
 * The title Claude wrote for the session, if this record is one.
 *
 * Claude appends `{"type":"ai-title","aiTitle":"…"}` as it revises its idea of
 * what the session is about — one live 11 MB session carries 136 of them — so
 * the **last** one is the current title and the first is a stale guess. They
 * are dense enough that the last always lands near the end of the file (2.5 KB
 * to 27 KB from EOF across the sessions on this machine), which is why a
 * bounded tail read finds it without scanning megabytes.
 *
 * Codex has no equivalent: its record types are `session_meta`, `event_msg`,
 * `response_item`, `world_state`, `turn_context`,
 * `inter_agent_communication_metadata` and `compacted` — nothing title-shaped.
 */
export const readRecordAiTitle = (record: Record<string, unknown>): string | null => {
  if (record["type"] !== "ai-title") return null;
  return asString(record["aiTitle"]);
};

/**
 * The first human message inside a Codex `compacted` record.
 *
 * Compaction replaces a run of history with a summary and preserves the
 * original messages under `payload.replacement_history`, in the response-item
 * shape (`content: [{type: "input_text", text}]`) rather than the `event_msg`
 * shape the rest of the reader speaks. Without this, a compacted rollout whose
 * early records were folded away has no opening message to show, and the
 * preview starts mid-conversation with nothing to correct the impression.
 */
export const readCompactedFirstUserMessage = (record: Record<string, unknown>): string | null => {
  if (record["type"] !== "compacted") return null;
  const payload = record["payload"];
  if (!isRecord(payload)) return null;
  const history = payload["replacement_history"];
  if (!Array.isArray(history)) return null;
  for (const item of history) {
    if (!isRecord(item) || item["role"] !== "user") continue;
    const content = item["content"];
    if (!Array.isArray(content)) {
      const direct = asString(content);
      if (direct !== null) return direct;
      continue;
    }
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const text = asString(block["text"]);
      if (text !== null) texts.push(text);
    }
    if (texts.length > 0) return texts.join("\n\n");
  }
  return null;
};

/**
 * The working directory a record reports, if it reports one.
 *
 * Both CLIs record where they ran — Claude on every conversation record, Codex
 * in the `session_meta` line — and that beats reconstructing it from a
 * directory name, which for Claude is lossy and for Codex is impossible.
 */
export const readRecordProjectPath = (
  provider: HistoryProvider,
  record: Record<string, unknown>,
): string | null => {
  if (provider === "claude") return asString(record["cwd"]);
  if (record["type"] !== "session_meta") return null;
  const payload = record["payload"];
  return isRecord(payload) ? asString(payload["cwd"]) : null;
};

/**
 * Folds a session's opening records into the two things a listing row needs.
 *
 * Callers feed lines from the head of the file and stop as soon as this
 * reports `complete` — which for a Claude session is usually within the first
 * few KB, and for a Codex session is after the ~60-80 KB preamble that
 * `session_meta` and the injected context occupy. That asymmetry is why
 * snippets are hydrated per page rather than at index time: reading 80 KB of
 * every one of thousands of Codex rollouts to build an index nobody has
 * scrolled to would cost hundreds of megabytes of I/O for nothing.
 */
export class SessionHeadFold {
  private projectPath: string | null = null;
  private snippet: string | null = null;
  private aiTitle: string | null = null;
  private readonly provider: HistoryProvider;

  constructor(provider: HistoryProvider) {
    this.provider = provider;
  }

  /** Returns true once nothing further can be learned from more lines. */
  push(line: string): boolean {
    const record = parseRecord(line);
    if (record === null) return this.complete;

    if (this.projectPath === null) {
      this.projectPath = readRecordProjectPath(this.provider, record);
    }
    // Head-side only. The authoritative title is the *last* one in the file,
    // which a tail read finds; this catches the case where a session is short
    // enough that head and tail are the same bytes.
    const aiTitle = readRecordAiTitle(record);
    if (aiTitle !== null) this.aiTitle = aiTitle;

    if (this.snippet === null) {
      const rendered = renderRecord(this.provider, record);
      if (rendered !== null && rendered.isHumanTurn) {
        const collapsed = collapseWhitespace(rendered.text);
        if (collapsed.length > 0) this.snippet = clip(collapsed, HISTORY_SNIPPET_MAX_CHARS);
      } else {
        // A compacted rollout may have folded the opening message away; the
        // originals survive inside the compaction record.
        const compacted = readCompactedFirstUserMessage(record);
        if (compacted !== null) {
          const collapsed = collapseWhitespace(compacted);
          if (collapsed.length > 0) this.snippet = clip(collapsed, HISTORY_SNIPPET_MAX_CHARS);
        }
      }
    }
    return this.complete;
  }

  get complete(): boolean {
    // The title is never waited for: most sessions have none, and blocking on
    // one would read the whole head budget of every row for nothing.
    return this.projectPath !== null && this.snippet !== null;
  }

  get result(): SessionHeadFacts {
    return { projectPath: this.projectPath, snippet: this.snippet, aiTitle: this.aiTitle };
  }
}

export interface SessionHeadFacts {
  readonly projectPath: string | null;
  readonly snippet: string | null;
  /** The title as of the head of the file; a tail read supersedes it. */
  readonly aiTitle: string | null;
}
