/**
 * Fork-owned: which thread is the orchestrator, and which threads it started.
 *
 * Two questions, both answered here because both are pure and both are easy to
 * get subtly wrong.
 *
 * **Which thread is master.** `workbenchMasterThreadId` is a *server* setting,
 * so every machine designates its own — the capability that carries the peer
 * write tools is issued by the machine hosting the thread, and it can only be
 * issued for a thread that machine knows about. The Workbench shows one master
 * at a time and prefers the local machine's, because that is the one an
 * operator sitting here designated.
 *
 * **Which threads it started.** Nothing on the wire says "this thread was
 * created by that thread": `peer_thread_create` dispatches a plain
 * `thread.create` to the peer and the peer stores no provenance. What does
 * survive is the master's own transcript — the tool call and its result, which
 * carries the new thread's id. So the tag is derived by reading the master's
 * activities. That makes it exactly as durable as the master's transcript, and
 * it is the only client-visible signal that exists today.
 */
import type { OrchestrationThreadActivity } from "@starcode/contracts";

export interface WorkbenchMasterCandidate {
  readonly environmentId: string;
  readonly label: string;
  /** Empty string means this machine has designated nothing, which is the default. */
  readonly masterThreadId: string;
  readonly isLocal: boolean;
}

export interface WorkbenchMasterDesignation {
  readonly environmentId: string;
  readonly label: string;
  readonly threadId: string;
  readonly isLocal: boolean;
}

export interface WorkbenchMasterResolution {
  readonly designated: WorkbenchMasterDesignation | null;
  /**
   * Every other machine that also names a master. Rendered as a switcher rather
   * than hidden: two designations is a legitimate state (an orchestrator per
   * machine), and silently showing one of them would make the other invisible.
   */
  readonly alternates: ReadonlyArray<WorkbenchMasterDesignation>;
}

/**
 * Local first, then alphabetical, then by id so the choice never depends on map
 * iteration order.
 */
export function resolveWorkbenchMaster(
  candidates: ReadonlyArray<WorkbenchMasterCandidate>,
): WorkbenchMasterResolution {
  const designations = candidates
    .filter((candidate) => candidate.masterThreadId.trim().length > 0)
    .map(
      (candidate): WorkbenchMasterDesignation => ({
        environmentId: candidate.environmentId,
        label: candidate.label,
        threadId: candidate.masterThreadId.trim(),
        isLocal: candidate.isLocal,
      }),
    )
    .toSorted((left, right) => {
      if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
      return (
        left.label.localeCompare(right.label) ||
        left.environmentId.localeCompare(right.environmentId)
      );
    });

  const [designated, ...alternates] = designations;
  return { designated: designated ?? null, alternates };
}

/** The tool this fork ships for starting work on another machine. */
const PEER_THREAD_CREATE_TOOL = "peer_thread_create";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pulls a thread id out of whatever an MCP result decoded to.
 *
 * Both shapes are handled because the two providers report tool results
 * differently: Codex hands over `structuredContent` already parsed, while
 * Claude passes through the raw `tool_result` block whose only payload is a
 * JSON string in a text part. Neither is guaranteed — a malformed result must
 * yield no tag rather than throw inside a render.
 */
function readThreadIdFromResult(result: unknown): string | null {
  const record = asRecord(result);
  if (record === null) return null;
  if (record.is_error === true || record.isError === true) return null;

  const structured = asRecord(record.structuredContent);
  if (structured !== null && typeof structured.threadId === "string") {
    return structured.threadId;
  }

  const content = record.content;
  const parts = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
  for (const part of parts) {
    const text = typeof part === "string" ? part : (asRecord(part)?.text ?? null);
    if (typeof text !== "string") continue;
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed !== null && typeof parsed.threadId === "string") {
        return parsed.threadId;
      }
    } catch {
      // A tool result that is not JSON is simply not a create result.
    }
  }
  return null;
}

/**
 * Thread ids the master created, read from its own transcript.
 *
 * Deliberately does **not** filter on `payload.itemType`. The Claude adapter
 * classifies a tool by substring, and `peer_thread_create` contains "create",
 * so it is filed as a file change rather than an MCP call — gating on
 * `mcp_tool_call` would silently find nothing. The tool name inside
 * `payload.data` is the reliable signal.
 */
export function collectMasterCreatedThreadIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const created = new Set<string>();
  for (const activity of activities) {
    if (activity.tone !== "tool") continue;
    const data = asRecord(asRecord(activity.payload)?.data);
    if (data === null) continue;

    // Claude: one flat record, the name carrying the MCP server prefix.
    const toolName = typeof data.toolName === "string" ? data.toolName : null;
    if (toolName !== null && toolName.endsWith(PEER_THREAD_CREATE_TOOL)) {
      const threadId = readThreadIdFromResult(data.result);
      if (threadId !== null) created.add(threadId);
      continue;
    }

    // Codex: the call is an item, with server and tool as separate fields.
    const item = asRecord(data.item);
    if (item !== null && item.tool === PEER_THREAD_CREATE_TOOL) {
      const threadId = readThreadIdFromResult(item.result);
      if (threadId !== null) created.add(threadId);
    }
  }
  return created;
}
