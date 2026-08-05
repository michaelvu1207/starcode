import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@starcode/contracts";

import {
  deriveLatestContextWindowSnapshot,
  deriveLatestTokensPerSecond,
  formatContextWindowTokens,
  formatTokensPerSecond,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: unknown,
  options?: { createdAt?: string; turnId?: string | null },
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: options?.turnId === null ? null : TurnId.make(options?.turnId ?? "turn-1"),
    createdAt: options?.createdAt ?? "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("derives and formats the latest output rate from provider duration", () => {
    const tokensPerSecond = deriveLatestTokensPerSecond([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 600,
        lastOutputTokens: 450,
        durationMs: 9_000,
      }),
    ]);

    expect(tokensPerSecond).toBe(50);
    expect(formatTokensPerSecond(tokensPerSecond)).toBe("50.0 tok/s");
  });

  it("falls back to the matching turn duration and output token field", () => {
    const tokensPerSecond = deriveLatestTokensPerSecond([
      makeActivity("turn-1", "turn.started", {}, { createdAt: "2026-03-23T00:00:00.000Z" }),
      makeActivity(
        "activity-1",
        "context-window.updated",
        { usedTokens: 600, outputTokens: 450 },
        { createdAt: "2026-03-23T00:00:09.000Z" },
      ),
    ]);

    expect(tokensPerSecond).toBe(50);
  });

  it("uses the latest turn timing when the provider omits the activity turn id", () => {
    const tokensPerSecond = deriveLatestTokensPerSecond(
      [
        makeActivity(
          "activity-1",
          "context-window.updated",
          { usedTokens: 600, lastOutputTokens: 450 },
          { createdAt: "2026-03-23T00:00:09.000Z", turnId: null },
        ),
      ],
      {
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-03-23T00:00:00.000Z",
          completedAt: "2026-03-23T00:00:09.000Z",
        },
      },
    );

    expect(tokensPerSecond).toBe(50);
  });

  it("hides the rate when usage is incomplete or cannot produce a positive rate", () => {
    expect(
      deriveLatestTokensPerSecond([
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 600,
          lastOutputTokens: 450,
          durationMs: 0,
        }),
      ]),
    ).toBeNull();
    expect(formatTokensPerSecond(null)).toBeNull();
  });
});
