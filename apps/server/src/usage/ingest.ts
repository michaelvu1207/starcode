/**
 * The bridge from runtime events to the usage store.
 *
 * Lives here rather than inside `ProviderRuntimeIngestion` so the fork's diff
 * in that file is a single call. It is invoked from the ingestion worker
 * instead of a second `providerService.streamEvents` subscription because the
 * worker is the one consumer guaranteed to see every event — `CheckpointReactor`
 * documents having lost `turn.completed` events on its own subscription, and an
 * undercounted spend total is worse than no total at all.
 *
 * Every failure is logged and swallowed: usage must never fail a turn.
 *
 * @module UsageIngest
 */
import type { ProviderRuntimeEvent } from "@starcode/contracts";
import * as Effect from "effect/Effect";

import { normalizeRateLimits, normalizeTurnCostUsd, normalizeTurnTokens } from "./normalize.ts";
import type { UsageStoreShape } from "./UsageStore.ts";

/** Runtime event types the usage store folds. */
export function isUsageRuntimeEvent(
  event: ProviderRuntimeEvent,
): event is Extract<
  ProviderRuntimeEvent,
  { type: "turn.completed" | "account.rate-limits.updated" }
> {
  return event.type === "turn.completed" || event.type === "account.rate-limits.updated";
}

export const recordUsageFromRuntimeEvent = (
  usageStore: UsageStoreShape,
  event: ProviderRuntimeEvent,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (!isUsageRuntimeEvent(event)) return Effect.void;
    // Usage is keyed by account, and the provider instance *is* the account.
    // `providerInstanceId` is optional in the contract only for legacy
    // emitters; `ProviderService` stamps it on every event it publishes.
    const providerInstanceId = event.providerInstanceId;
    if (providerInstanceId === undefined) return Effect.void;

    if (event.type === "account.rate-limits.updated") {
      const snapshot = normalizeRateLimits({
        driver: event.provider,
        payload: event.payload.rateLimits,
        observedAt: event.createdAt,
      });
      if (snapshot === null) return Effect.void;
      return usageStore.recordRateLimits({
        providerInstanceId,
        driver: event.provider,
        snapshot,
      });
    }

    const tokens = normalizeTurnTokens(event.payload.usage);
    const costUsd = normalizeTurnCostUsd(event.payload.totalCostUsd);
    // A turn that reported neither cost nor tokens contributes nothing but a
    // row; skipping it keeps the table to turns that actually cost something.
    if (
      costUsd === 0 &&
      tokens.inputTokens === 0 &&
      tokens.cachedInputTokens === 0 &&
      tokens.outputTokens === 0 &&
      tokens.reasoningOutputTokens === 0
    ) {
      return Effect.void;
    }

    return usageStore.recordTurn({
      eventId: event.eventId,
      providerInstanceId,
      driver: event.provider,
      threadId: event.threadId,
      turnId: event.turnId ?? null,
      completedAt: event.createdAt,
      costUsd,
      ...tokens,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("usage ingestion failed", {
        eventId: event.eventId,
        eventType: event.type,
        cause,
      }),
    ),
  );
