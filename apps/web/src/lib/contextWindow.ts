import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ThreadTokenUsageSnapshot,
} from "@starcode/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

type ContextWindowActivity = {
  readonly activity: OrchestrationThreadActivity;
  readonly snapshot: ContextWindowSnapshot;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode (legacy)";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

function deriveContextWindowSnapshot(
  activity: OrchestrationThreadActivity,
): ContextWindowSnapshot | null {
  const payload = asRecord(activity.payload);
  const usedTokens = asFiniteNumber(payload?.usedTokens);
  if (usedTokens === null || usedTokens < 0) {
    return null;
  }

  const maxTokens = asFiniteNumber(payload?.maxTokens);
  const usedPercentage =
    maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
  const remainingTokens =
    maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
  const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

  return {
    usedTokens,
    totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
    maxTokens,
    remainingTokens,
    usedPercentage,
    remainingPercentage,
    inputTokens: asFiniteNumber(payload?.inputTokens),
    cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
    outputTokens: asFiniteNumber(payload?.outputTokens),
    reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
    lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
    lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
    lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
    lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
    lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
    toolUses: asFiniteNumber(payload?.toolUses),
    durationMs: asFiniteNumber(payload?.durationMs),
    compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
    updatedAt: activity.createdAt,
  };
}

function findLatestContextWindowActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowActivity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const snapshot = deriveContextWindowSnapshot(activity);
    if (snapshot) {
      return { activity, snapshot };
    }
  }

  return null;
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  return findLatestContextWindowActivity(activities)?.snapshot ?? null;
}

function deriveTurnDurationMs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  contextWindowActivity: OrchestrationThreadActivity,
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt"> | null,
): number | null {
  const contextUpdatedAt = Date.parse(contextWindowActivity.createdAt);
  if (!Number.isFinite(contextUpdatedAt)) {
    return null;
  }

  if (contextWindowActivity.turnId) {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const activity = activities[index];
      if (activity?.kind !== "turn.started" || activity.turnId !== contextWindowActivity.turnId) {
        continue;
      }
      const turnStartedAt = Date.parse(activity.createdAt);
      if (!Number.isFinite(turnStartedAt) || contextUpdatedAt <= turnStartedAt) {
        return null;
      }
      return contextUpdatedAt - turnStartedAt;
    }
  }

  if (
    !latestTurn ||
    (contextWindowActivity.turnId !== null && contextWindowActivity.turnId !== latestTurn.turnId) ||
    latestTurn.startedAt === null
  ) {
    return null;
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = latestTurn.completedAt
    ? Date.parse(latestTurn.completedAt)
    : contextUpdatedAt;
  if (!Number.isFinite(turnStartedAt) || !Number.isFinite(turnCompletedAt)) {
    return null;
  }
  return turnCompletedAt > turnStartedAt ? turnCompletedAt - turnStartedAt : null;
}

export function deriveLatestTokensPerSecond(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: {
    readonly latestTurn?: Pick<
      OrchestrationLatestTurn,
      "turnId" | "startedAt" | "completedAt"
    > | null;
  },
): number | null {
  const latest = findLatestContextWindowActivity(activities);
  if (!latest) {
    return null;
  }

  const outputTokens = latest.snapshot.lastOutputTokens ?? latest.snapshot.outputTokens ?? null;
  const durationMs =
    latest.snapshot.durationMs ??
    deriveTurnDurationMs(activities, latest.activity, options?.latestTurn ?? null);
  if (
    outputTokens === null ||
    outputTokens <= 0 ||
    durationMs === null ||
    durationMs <= 0 ||
    !Number.isFinite(durationMs)
  ) {
    return null;
  }

  const tokensPerSecond = outputTokens / (durationMs / 1_000);
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : null;
}

export function formatTokensPerSecond(tokensPerSecond: number | null): string | null {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    return null;
  }
  return `${tokensPerSecond.toFixed(1)} tok/s`;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
