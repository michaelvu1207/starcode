/**
 * threadSubagentSummary - Fold a thread's `task.*` activity payloads into the
 * list of live subagents carried by thread shells.
 *
 * Kept pure and separate from the snapshot query for the same reasons as
 * `threadPlanSummary`: the parsing rules are testable on their own, and the
 * query keeps a call-site-sized diff.
 *
 * Two rules the shape of the data forces, both easy to get wrong:
 *
 * 1. **Usage replaces, never accumulates.** `total_tokens` on a progress event
 *    is a running total for the task, not a delta. Summing them would report
 *    millions of tokens for an agent that used eighty thousand.
 * 2. **Progress is proof of life.** A `task.progress` arriving after an
 *    out-of-order terminal event reopens the agent, mirroring the client's
 *    `deriveSubagentTasks`. The two folds have to agree, or a thread's sidebar
 *    row and its own panel will disagree about what is running.
 *
 * @module threadSubagentSummary
 */
import type { OrchestrationThreadSubagent } from "@starcode/contracts";

type FoldStatus = "running" | "paused" | "completed" | "failed" | "stopped";

interface FoldedTask {
  taskId: string;
  taskType: string | null;
  toolUseId: string | null;
  description: string | null;
  subagentType: string | null;
  status: FoldStatus;
  isBackgrounded: boolean;
  lastToolName: string | null;
  totalTokens: number | null;
  startedAt: string;
}

/** One `task.*` activity, in the shape the projection row supplies. */
export interface SubagentActivityRow {
  readonly kind: string;
  readonly createdAt: string;
  readonly payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedTaskType(value: unknown): string | null {
  return optionalString(value)?.toLowerCase().replaceAll("-", "_") ?? null;
}

function optionalNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded >= 0 ? rounded : null;
}

/**
 * `task.updated` reports the SDK's own status vocabulary, which is wider than
 * the fold's. `killed` is normalized to `stopped` so the two agree with the
 * client, and an unrecognized value leaves the status alone rather than
 * guessing — an agent we half-understand is still an agent worth showing.
 */
function statusFromPatch(value: unknown, current: FoldStatus): FoldStatus {
  switch (value) {
    case "running":
    case "pending":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    default:
      return current;
  }
}

function statusFromTerminal(value: unknown): FoldStatus {
  return value === "failed" ? "failed" : value === "stopped" ? "stopped" : "completed";
}

/**
 * Reduce a thread's `task.*` activities to the subagents still in flight,
 * oldest first so a sidebar's child rows do not reshuffle as tokens tick up.
 *
 * Rows must arrive in ascending activity order; the caller owns that ordering
 * because it is the same ordering the activity repository already applies.
 */
export function deriveLiveSubagents(
  rows: ReadonlyArray<SubagentActivityRow>,
): ReadonlyArray<OrchestrationThreadSubagent> {
  const byTaskId = new Map<string, FoldedTask>();

  for (const row of rows) {
    if (!row.kind.startsWith("task.")) continue;
    const payload = asRecord(row.payload);
    const taskId = optionalString(payload?.taskId);
    if (!payload || !taskId) continue;

    const existing = byTaskId.get(taskId);
    const task: FoldedTask = existing ?? {
      taskId,
      taskType: null,
      toolUseId: null,
      description: null,
      subagentType: null,
      status: "running",
      isBackgrounded: false,
      lastToolName: null,
      totalTokens: null,
      startedAt: row.createdAt,
    };

    // The opening event owns the stable agent identity. Progress titles are
    // deliberately ephemeral: Pi reports reasoning snippets, tool commands,
    // and tool output there. Replacing the launch description with those
    // values makes sidebar rows flicker into strings such as `{\"goal\":null}`
    // or an entire shell result. Legacy streams that have no opening row still
    // receive a best-effort description from their first observed activity.
    if (task.description === null) {
      task.description =
        optionalString(payload.description) ??
        optionalString(payload.detail) ??
        optionalString(payload.title);
    }
    task.taskType = normalizedTaskType(payload.taskType) ?? task.taskType;
    task.subagentType = optionalString(payload.subagentType) ?? task.subagentType;
    task.toolUseId = optionalString(payload.toolUseId) ?? task.toolUseId;

    const usage = asRecord(payload.usage);
    if (usage) {
      task.totalTokens = optionalNonNegativeInt(usage.total_tokens) ?? task.totalTokens;
    }

    switch (row.kind) {
      case "task.started":
        task.status = "running";
        break;
      case "task.progress":
        task.lastToolName = optionalString(payload.lastToolName) ?? task.lastToolName;
        task.status = "running";
        break;
      case "task.updated":
        task.status = statusFromPatch(payload.status, task.status);
        if (typeof payload.isBackgrounded === "boolean") {
          task.isBackgrounded = payload.isBackgrounded;
        }
        break;
      case "task.completed":
        task.status = statusFromTerminal(payload.status);
        // Nothing is running any more, so a live subtitle would be a lie.
        task.lastToolName = null;
        break;
      default:
        break;
    }

    byTaskId.set(taskId, task);
  }

  const live: Array<OrchestrationThreadSubagent> = [];
  for (const task of byTaskId.values()) {
    // Claude uses the same task lifecycle for real subagents and background
    // shell commands. A long-running dev server is live work, but it is not a
    // subagent and has no AgentRun row to render beneath the thread.
    if (task.taskType === "local_bash") continue;
    if (task.status !== "running" && task.status !== "paused") continue;
    live.push({
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      description: task.description,
      subagentType: task.subagentType,
      status: task.status,
      isBackgrounded: task.isBackgrounded,
      lastToolName: task.lastToolName,
      totalTokens: task.totalTokens,
      startedAt: task.startedAt,
    } satisfies OrchestrationThreadSubagent);
  }
  return live;
}
