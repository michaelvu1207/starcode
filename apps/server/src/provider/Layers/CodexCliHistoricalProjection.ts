// @effect-diagnostics nodeBuiltinImport:off globalDate:off - historical linking
// resolves recorded shell cwd values and compares persisted launch timestamps.
import * as NodePath from "node:path";

import type { HistorySessionId, OrchestrationThreadActivity } from "@starcode/contracts";
import { detectCodexCliSubagent } from "@starcode/shared/codexCliSubagent";

import {
  type CodexCliRolloutLink,
  discoverCodexCliRollout,
  probeCodexCliRolloutLiveness,
  readCodexCliRolloutTerminal,
  resolveCodexCliInvocationPrompt,
} from "./CodexCliRolloutDiscovery.ts";

const UNTERMINATED_STALE_MS = 86_400_000;

type HistoricalRolloutStatus = "running" | "completed" | "failed" | "stopped";
type HistoricalRolloutLiveness = "live" | "closed" | "unknown";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function providerItemId(payload: Record<string, unknown> | null): string | null {
  // Current live adapter events use providerItemId. Historical projection
  // rows persisted the provider's item key as itemId, so both are explicit
  // lifecycle join keys rather than a heuristic correlation.
  return string(payload?.providerItemId) ?? string(payload?.itemId);
}

function rolloutStatus(
  terminal: { readonly status: "completed" | "failed"; readonly at: string } | null,
  live: boolean | null,
  startedAt: string,
  nowMs: number,
): {
  readonly status: HistoricalRolloutStatus;
  readonly at: string;
  readonly liveness: HistoricalRolloutLiveness;
} {
  if (terminal !== null) return { ...terminal, liveness: "closed" };
  if (live === true) {
    return { status: "running", at: new Date(nowMs).toISOString(), liveness: "live" };
  }
  if (live === false) {
    return { status: "stopped", at: new Date(nowMs).toISOString(), liveness: "closed" };
  }
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return {
      status: "running",
      at: new Date(nowMs).toISOString(),
      liveness: "unknown",
    };
  }
  return nowMs - startedAtMs <= UNTERMINATED_STALE_MS
    ? {
        status: "running",
        at: new Date(nowMs).toISOString(),
        liveness: "unknown",
      }
    : {
        status: "stopped",
        at: new Date(startedAtMs + UNTERMINATED_STALE_MS).toISOString(),
        liveness: "unknown",
      };
}

function withRollout(
  activity: OrchestrationThreadActivity,
  historySessionId: HistorySessionId,
  rollout: {
    readonly status: HistoricalRolloutStatus;
    readonly at: string;
    readonly liveness: HistoricalRolloutLiveness;
  },
): OrchestrationThreadActivity {
  const payload = record(activity.payload) ?? {};
  return {
    ...activity,
    payload: {
      ...payload,
      codexCliHistorySessionId: historySessionId,
      codexCliRolloutStatus: rollout.status,
      codexCliRolloutStatusAt: rollout.at,
      codexCliRolloutLiveness: rollout.liveness,
    },
  };
}

/**
 * Recovers rollout links for launch activities written before Starcode began
 * persisting `historySessionId` on Codex CLI task events.
 *
 * This is deliberately read-only and conservative. A rollout is attached only
 * through the same unique metadata/cwd/time/prompt proof used for live launches.
 * Resume calls reuse a rollout already proved earlier in this same thread and
 * cwd. Ambiguous candidates remain untouched.
 */
export async function enrichHistoricalCodexCliActivities(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly parentCwd: string;
  readonly codexHome?: string | undefined;
  readonly nowMs?: number | undefined;
  readonly probeRolloutLiveness?: ((path: string) => Promise<boolean | null>) | undefined;
}): Promise<ReadonlyArray<OrchestrationThreadActivity>> {
  const orderedIndexes = input.activities
    .map((activity, index) => ({ activity, index }))
    .toSorted((left, right) => left.activity.createdAt.localeCompare(right.activity.createdAt));
  const result = [...input.activities];
  const seenToolUseIds = new Set<string>();
  const rolloutByCwd = new Map<string, CodexCliRolloutLink | null>();
  const nowMs = input.nowMs ?? Date.now();
  const codexHome = input.codexHome ?? process.env.CODEX_HOME;
  const probeRolloutLiveness = input.probeRolloutLiveness ?? probeCodexCliRolloutLiveness;

  for (const { activity, index } of orderedIndexes) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const payload = record(activity.payload);
    const data = record(payload?.data);
    const toolName = string(data?.toolName);
    const toolInput = record(data?.input);
    const toolUseId = providerItemId(payload);
    if (!toolName || !toolInput || !toolUseId || seenToolUseIds.has(toolUseId)) continue;

    const invocation = detectCodexCliSubagent(toolName, toolInput);
    if (!invocation) continue;
    seenToolUseIds.add(toolUseId);

    const shellCwd = NodePath.resolve(input.parentCwd, invocation.shellCwd ?? ".");
    const cwd = NodePath.resolve(shellCwd, invocation.cwd ?? ".");
    const prompt = await resolveCodexCliInvocationPrompt({
      invocation,
      parentCwd: input.parentCwd,
    });
    let link = invocation.resumeLast === true ? (rolloutByCwd.get(cwd) ?? null) : null;

    if (!invocation.resumeLast && prompt) {
      try {
        link = await discoverCodexCliRollout({
          ...(codexHome ? { codexHome } : {}),
          cwd,
          prompt,
          startedAt: activity.createdAt,
        });
      } catch {
        link = null;
      }
      if (link !== null) {
        const previous = rolloutByCwd.get(cwd);
        rolloutByCwd.set(
          cwd,
          previous === undefined || previous?.nativeSessionId === link.nativeSessionId
            ? link
            : null,
        );
      }
    }

    if (link === null) continue;
    let terminal: { readonly status: "completed" | "failed"; readonly at: string } | null;
    try {
      terminal = await readCodexCliRolloutTerminal(link.path, activity.createdAt);
    } catch {
      continue;
    }
    let live: boolean | null = null;
    if (terminal === null) {
      try {
        live = await probeRolloutLiveness(link.path);
      } catch {
        live = null;
      }
    }
    result[index] = withRollout(
      activity,
      link.historySessionId,
      rolloutStatus(terminal, live, activity.createdAt, nowMs),
    );
  }

  return result;
}
