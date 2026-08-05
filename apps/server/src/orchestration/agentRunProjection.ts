import type { AgentRunStatus, ThreadId } from "@starcode/contracts";

import type { ProjectionAgentRun } from "../persistence/Services/ProjectionAgentRuns.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function providerOptions(value: unknown): ProjectionAgentRun["options"] {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((entry) => {
    const candidate = record(entry);
    const id = text(candidate?.id);
    const optionValue = candidate?.value;
    return id !== null && (typeof optionValue === "string" || typeof optionValue === "boolean")
      ? [{ id, value: optionValue }]
      : [];
  });
  return options;
}

function normalizedTaskType(payload: Record<string, unknown>): string | null {
  return text(payload.taskType)?.toLowerCase().replaceAll("-", "_") ?? null;
}

function hasExplicitAgentEvidence(payload: Record<string, unknown>, taskId: string): boolean {
  const taskType = normalizedTaskType(payload);
  if (taskType === "local_bash") return false;
  return (
    taskType === "codex_cli" ||
    taskType === "agent" ||
    taskType?.endsWith("_agent") === true ||
    text(payload.subagentType) !== null ||
    text(payload.historySessionId) !== null ||
    taskId.startsWith("codex-cli:")
  );
}

function lifecycleStatus(
  kind: string,
  payload: Record<string, unknown>,
  current: AgentRunStatus | null,
): AgentRunStatus {
  if (kind === "task.completed") {
    return payload.status === "failed"
      ? "failed"
      : payload.status === "stopped"
        ? "stopped"
        : "completed";
  }
  if (kind === "task.updated") {
    switch (payload.status) {
      case "completed":
      case "failed":
      case "paused":
      case "running":
        return payload.status;
      case "killed":
      case "stopped":
        return "stopped";
      default:
        break;
    }
  }
  if (kind === "task.started" || kind === "task.progress") return "running";
  return current ?? "running";
}

/**
 * Fold one persisted task lifecycle activity into a provider-neutral agent
 * run. Returns null for ordinary background jobs and unprovable legacy tasks.
 */
export function projectAgentRunActivity(input: {
  readonly parentThreadId: ThreadId;
  readonly kind: string;
  readonly createdAt: string;
  readonly payload: unknown;
  readonly existing: ProjectionAgentRun | null;
}): ProjectionAgentRun | null {
  if (!input.kind.startsWith("task.")) return null;
  const payload = record(input.payload);
  const taskId = text(payload?.taskId);
  if (!payload || !taskId) return null;

  if (input.existing === null && !hasExplicitAgentEvidence(payload, taskId)) {
    return null;
  }
  if (normalizedTaskType(payload) === "local_bash") return null;

  const taskType = text(payload.taskType) ?? input.existing?.taskType ?? null;
  const provider =
    text(payload.providerDriver) ??
    (taskType?.toLowerCase().replaceAll("-", "_") === "codex_cli" || taskId.startsWith("codex-cli:")
      ? "codex"
      : (input.existing?.provider ?? "claude"));
  const historySessionId =
    (text(payload.historySessionId) as ProjectionAgentRun["historySessionId"]) ??
    input.existing?.historySessionId ??
    null;
  const options = providerOptions(payload.options) ?? input.existing?.options;
  return {
    parentThreadId: input.parentThreadId,
    provider: provider as ProjectionAgentRun["provider"],
    ...(((text(payload.providerInstanceId) as ProjectionAgentRun["providerInstanceId"]) ??
    input.existing?.providerInstanceId)
      ? {
          providerInstanceId:
            (text(payload.providerInstanceId) as ProjectionAgentRun["providerInstanceId"]) ??
            input.existing?.providerInstanceId,
        }
      : {}),
    agentRunId: taskId,
    ...((text(payload.parentAgentRunId) ?? input.existing?.parentAgentRunId)
      ? {
          parentAgentRunId:
            text(payload.parentAgentRunId) ?? input.existing?.parentAgentRunId ?? null,
        }
      : {}),
    launchToolUseId: text(payload.toolUseId) ?? input.existing?.launchToolUseId ?? null,
    taskType,
    agentType: text(payload.subagentType) ?? input.existing?.agentType ?? null,
    model: text(payload.model) ?? input.existing?.model ?? null,
    ...(options !== undefined ? { options } : {}),
    description:
      input.existing?.description ??
      text(payload.title) ??
      text(payload.detail) ??
      text(payload.description) ??
      null,
    status: lifecycleStatus(input.kind, payload, input.existing?.status ?? null),
    startedAt:
      input.existing === null
        ? input.createdAt
        : input.existing.startedAt.localeCompare(input.createdAt) <= 0
          ? input.existing.startedAt
          : input.createdAt,
    updatedAt:
      input.existing !== null && input.existing.updatedAt.localeCompare(input.createdAt) > 0
        ? input.existing.updatedAt
        : input.createdAt,
    historySessionId,
    transcriptState: historySessionId === null ? "pending" : "linked",
    parentNativeSessionId:
      text(payload.parentNativeSessionId) ?? input.existing?.parentNativeSessionId ?? null,
  };
}
