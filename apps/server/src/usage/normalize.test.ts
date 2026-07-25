import { assert, describe, it } from "@effect/vitest";
import type { ProviderDriverKind } from "@t3tools/contracts";

import {
  epochToIso,
  normalizeRateLimits,
  normalizeTurnCostUsd,
  normalizeTurnTokens,
} from "./normalize.ts";

const claude = "claudeAgent" as ProviderDriverKind;
const codex = "codex" as ProviderDriverKind;
const observedAt = "2026-07-24T12:00:00.000Z";

describe("epochToIso", () => {
  it("reads plain epoch numbers as seconds", () => {
    assert.strictEqual(epochToIso(1_784_000_000), "2026-07-14T03:33:20.000Z");
  });

  it("reads millisecond-scale numbers as milliseconds", () => {
    assert.strictEqual(epochToIso(1_784_000_000_000), "2026-07-14T03:33:20.000Z");
  });

  it("rejects non-numeric, zero and negative instants", () => {
    assert.isNull(epochToIso("2026-07-15"));
    assert.isNull(epochToIso(0));
    assert.isNull(epochToIso(-5));
    assert.isNull(epochToIso(undefined));
  });
});

describe("normalizeRateLimits — claude", () => {
  it("reads the SDK rate_limit_event wrapper", () => {
    const snapshot = normalizeRateLimits({
      driver: claude,
      observedAt,
      payload: {
        type: "rate_limit_event",
        session_id: "abc",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 82,
          resetsAt: 1_784_000_000,
        },
      },
    });

    assert.isNotNull(snapshot);
    assert.strictEqual(snapshot?.status, "warning");
    assert.deepStrictEqual(snapshot?.windows, [
      {
        key: "five_hour",
        label: "Five hour",
        usedPercent: 82,
        resetsAt: "2026-07-14T03:33:20.000Z",
        windowMinutes: null,
      },
    ]);
  });

  it("reports a bare reset instant as unknown consumption, not zero", () => {
    // Verbatim payload captured from claude 2.1.219 on a healthy account:
    // `utilization` is absent until the account nears its limit.
    const snapshot = normalizeRateLimits({
      driver: claude,
      observedAt,
      payload: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1_784_943_000,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
          isUsingOverage: false,
        },
        uuid: "0d71e8f6-0978-4e0e-8401-fa99da3e96db",
        session_id: "04ca6bd2-884d-4912-97f0-a9c06a1e73ba",
      },
    });

    assert.deepStrictEqual(snapshot?.windows, [
      {
        key: "five_hour",
        label: "Five hour",
        usedPercent: null,
        resetsAt: "2026-07-25T01:30:00.000Z",
        windowMinutes: null,
      },
    ]);
    // overageStatus "rejected" describes overage availability, not the
    // account's own limit — the account itself is still allowed.
    assert.strictEqual(snapshot?.status, "allowed");
  });

  it("clamps utilization into 0-100 so a bar cannot overflow", () => {
    const snapshot = normalizeRateLimits({
      driver: claude,
      observedAt,
      payload: { rate_limit_info: { status: "rejected", utilization: 143 } },
    });

    assert.strictEqual(snapshot?.status, "rejected");
    assert.strictEqual(snapshot?.windows[0]?.usedPercent, 100);
  });

  it("adds an overage window only when overage is actually in use", () => {
    const snapshot = normalizeRateLimits({
      driver: claude,
      observedAt,
      payload: {
        rate_limit_info: {
          status: "allowed",
          utilization: 10,
          isUsingOverage: true,
          overageResetsAt: 1_784_000_000,
        },
      },
    });

    assert.strictEqual(snapshot?.windows.length, 2);
    assert.strictEqual(snapshot?.windows[1]?.key, "overage");
  });

  it("returns null when the event carries neither utilization nor a reset", () => {
    assert.isNull(
      normalizeRateLimits({
        driver: claude,
        observedAt,
        payload: { rate_limit_info: { status: "allowed" } },
      }),
    );
  });
});

describe("normalizeRateLimits — codex", () => {
  it("unwraps the notification and reads both windows", () => {
    const snapshot = normalizeRateLimits({
      driver: codex,
      observedAt,
      payload: {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 31, resetsAt: 1_784_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 7, windowDurationMins: 10_080 },
        },
      },
    });

    assert.strictEqual(snapshot?.planLabel, "pro");
    assert.strictEqual(snapshot?.status, "allowed");
    assert.deepStrictEqual(
      snapshot?.windows.map((window) => [window.key, window.usedPercent, window.windowMinutes]),
      [
        ["primary", 31, 300],
        ["secondary", 7, 10_080],
      ],
    );
  });

  it("accepts an already-unwrapped snapshot", () => {
    const snapshot = normalizeRateLimits({
      driver: codex,
      observedAt,
      payload: { primary: { usedPercent: 50 } },
    });

    assert.strictEqual(snapshot?.windows.length, 1);
  });

  it("marks a reached limit as rejected and drops an unknown plan", () => {
    const snapshot = normalizeRateLimits({
      driver: codex,
      observedAt,
      payload: {
        rateLimits: {
          planType: "unknown",
          rateLimitReachedType: "rate_limit_reached",
          primary: { usedPercent: 100 },
        },
      },
    });

    assert.strictEqual(snapshot?.status, "rejected");
    assert.isNull(snapshot?.planLabel ?? null);
  });

  it("returns null when no window carries a used percentage", () => {
    assert.isNull(
      normalizeRateLimits({
        driver: codex,
        observedAt,
        payload: { rateLimits: { planType: "pro", primary: { resetsAt: 1_784_000_000 } } },
      }),
    );
  });
});

describe("normalizeRateLimits — other drivers", () => {
  it("ignores providers with no normalizer rather than guessing", () => {
    assert.isNull(
      normalizeRateLimits({
        driver: "cursor" as ProviderDriverKind,
        observedAt,
        payload: { rateLimits: { primary: { usedPercent: 12 } } },
      }),
    );
  });
});

describe("normalizeTurnTokens", () => {
  it("folds cache writes into input and keeps cache reads separate", () => {
    assert.deepStrictEqual(
      normalizeTurnTokens({
        input_tokens: 120,
        cache_creation_input_tokens: 80,
        cache_read_input_tokens: 4_000,
        output_tokens: 310,
      }),
      {
        inputTokens: 200,
        cachedInputTokens: 4_000,
        outputTokens: 310,
        reasoningOutputTokens: 0,
      },
    );
  });

  it("reads camelCase token counts", () => {
    assert.deepStrictEqual(
      normalizeTurnTokens({
        inputTokens: 10,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 40,
      }),
      {
        inputTokens: 10,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 40,
      },
    );
  });

  it("treats an unusable usage blob as zero rather than failing", () => {
    for (const usage of [null, undefined, "nope", 42, []]) {
      assert.deepStrictEqual(normalizeTurnTokens(usage), {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      });
    }
  });
});

describe("normalizeTurnCostUsd", () => {
  it("keeps a reported cost and drops nonsense", () => {
    assert.strictEqual(normalizeTurnCostUsd(0.0431), 0.0431);
    assert.strictEqual(normalizeTurnCostUsd(-1), 0);
    assert.strictEqual(normalizeTurnCostUsd(Number.NaN), 0);
    assert.strictEqual(normalizeTurnCostUsd(undefined), 0);
    assert.strictEqual(normalizeTurnCostUsd("0.5"), 0);
  });
});
