/**
 * Normalizers for the two provider usage payloads.
 *
 * `AccountRateLimitsUpdatedPayload.rateLimits` and `TurnCompletedPayload.usage`
 * are both `Schema.Unknown` in the contracts: the adapters forward whatever the
 * upstream CLI sent, unvalidated. Everything here therefore reads defensively
 * and returns `null` rather than failing — a provider that changes its payload
 * shape must degrade to "no data", never break turn ingestion.
 *
 * @module UsageNormalize
 */
import type {
  ProviderDriverKind,
  UsageRateLimitSnapshot,
  UsageRateLimitWindow,
} from "@starcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Token counts we can extract from a turn's usage blob. */
export interface TurnTokenTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export const EMPTY_TURN_TOKEN_TOTALS: TurnTokenTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonNegativeInt(value: unknown): number {
  const numeric = asFiniteNumber(value);
  return numeric === null || numeric < 0 ? 0 : Math.round(numeric);
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  return value > 100 ? 100 : value;
}

/**
 * Epoch instants arrive as seconds from Claude and Codex alike, but neither
 * documents the unit and both have shipped millisecond values in other
 * surfaces. Anything below the year-5138 boundary in seconds is read as
 * seconds; larger values are read as milliseconds.
 */
const EPOCH_SECONDS_CEILING = 100_000_000_000;

export function epochToIso(value: unknown): string | null {
  const numeric = asFiniteNumber(value);
  if (numeric === null || numeric <= 0) return null;
  const ms = numeric < EPOCH_SECONDS_CEILING ? numeric * 1_000 : numeric;
  const instant = DateTime.make(ms);
  return Option.isNone(instant) ? null : DateTime.formatIso(instant.value);
}

function labelFromWindowKey(key: string): string {
  const words = key.split(/[_\-\s]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return key;
  const [first, ...rest] = words as [string, ...Array<string>];
  return [`${first.charAt(0).toUpperCase()}${first.slice(1)}`, ...rest].join(" ");
}

function makeWindow(input: {
  readonly key: string;
  readonly label?: string | undefined;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly windowMinutes: number | null;
}): UsageRateLimitWindow {
  return {
    key: input.key,
    label: input.label ?? labelFromWindowKey(input.key),
    usedPercent: input.usedPercent === null ? null : clampPercent(input.usedPercent),
    resetsAt: input.resetsAt,
    windowMinutes:
      input.windowMinutes !== null && input.windowMinutes >= 1
        ? Math.round(input.windowMinutes)
        : null,
  };
}

/**
 * Claude's `rate_limit_event`, as forwarded by `ClaudeAdapter`: the whole SDK
 * message, whose `rate_limit_info` carries the account state. `utilization` is
 * read as a percentage; the SDK also ships `surpassedThreshold` as a percent,
 * so a fraction there would be inconsistent with its own sibling field.
 */
function normalizeClaudeRateLimits(
  payload: unknown,
  observedAt: string,
): UsageRateLimitSnapshot | null {
  const message = asRecord(payload);
  if (message === null) return null;
  const info = asRecord(message["rate_limit_info"]) ?? message;

  const rawStatus = info["status"];
  const status: UsageRateLimitSnapshot["status"] =
    rawStatus === "rejected" ? "rejected" : rawStatus === "allowed_warning" ? "warning" : "allowed";

  const utilization = asFiniteNumber(info["utilization"]);
  const rateLimitType = typeof info["rateLimitType"] === "string" ? info["rateLimitType"] : null;
  const resetsAt = epochToIso(info["resetsAt"]);

  // A rate_limit_event with neither a utilization nor a reset instant carries
  // nothing a bar could show; treat it as absent rather than render an empty
  // 0% bar that looks like real headroom.
  if (utilization === null && resetsAt === null) return null;

  const windows: Array<UsageRateLimitWindow> = [
    makeWindow({
      key: rateLimitType ?? "session",
      // Absent until the account nears its limit; reported as unknown rather
      // than as 0%, which would read as "plenty left".
      usedPercent: utilization,
      resetsAt,
      windowMinutes: null,
    }),
  ];

  const overageResetsAt = epochToIso(info["overageResetsAt"]);
  if (info["isUsingOverage"] === true || info["overageInUse"] === true) {
    windows.push(
      makeWindow({
        key: "overage",
        label: "Overage",
        usedPercent: 100,
        resetsAt: overageResetsAt,
        windowMinutes: null,
      }),
    );
  }

  return { status, planLabel: null, windows, observedAt };
}

/**
 * Codex's `account/rateLimits/updated`. The adapter forwards the notification
 * object, which itself wraps the snapshot under `rateLimits` — hence the
 * unwrap-one-level dance before reading `primary`/`secondary`.
 */
function normalizeCodexRateLimits(
  payload: unknown,
  observedAt: string,
): UsageRateLimitSnapshot | null {
  const outer = asRecord(payload);
  if (outer === null) return null;
  const snapshot = asRecord(outer["rateLimits"]) ?? outer;

  const windows: Array<UsageRateLimitWindow> = [];
  for (const [key, label] of [
    ["primary", "Primary"],
    ["secondary", "Secondary"],
  ] as const) {
    const window = asRecord(snapshot[key]);
    if (window === null) continue;
    const usedPercent = asFiniteNumber(window["usedPercent"]);
    if (usedPercent === null) continue;
    windows.push(
      makeWindow({
        key,
        label,
        usedPercent,
        resetsAt: epochToIso(window["resetsAt"]),
        windowMinutes: asFiniteNumber(window["windowDurationMins"]),
      }),
    );
  }

  if (windows.length === 0) return null;

  const planType = typeof snapshot["planType"] === "string" ? snapshot["planType"] : null;
  const reached = typeof snapshot["rateLimitReachedType"] === "string";
  const spendControlReached = snapshot["spendControlReached"] === true;

  return {
    status: reached || spendControlReached ? "rejected" : "allowed",
    planLabel: planType !== null && planType !== "unknown" ? planType : null,
    windows,
    observedAt,
  };
}

export function normalizeRateLimits(input: {
  readonly driver: ProviderDriverKind;
  readonly payload: unknown;
  readonly observedAt: string;
}): UsageRateLimitSnapshot | null {
  switch (input.driver as string) {
    // The Claude driver's kind slug is "claudeAgent", not "claude" — see
    // Drivers/ClaudeDriver.ts. Matching on "claude" silently drops every
    // Claude rate-limit event.
    case "claudeAgent":
      return normalizeClaudeRateLimits(input.payload, input.observedAt);
    case "codex":
      return normalizeCodexRateLimits(input.payload, input.observedAt);
    default:
      // Cursor/Grok/OpenCode never emit account.rate-limits.updated today. If
      // one starts, it lands here and is ignored until a normalizer exists,
      // rather than being guessed at.
      return null;
  }
}

/**
 * Read token counts out of `turn.completed`'s opaque `usage`. Claude forwards
 * the Anthropic API's snake_case usage block; Codex forwards its own camelCase
 * token counts. Unknown keys contribute zero rather than failing the fold.
 */
export function normalizeTurnTokens(usage: unknown): TurnTokenTotals {
  const record = asRecord(usage);
  if (record === null) return EMPTY_TURN_TOKEN_TOTALS;

  // Cache writes are billed as input, so they belong in the input total; cache
  // reads are broken out separately because they are the cheap ones and the
  // panel shows the split.
  const snakeCaseInput =
    asNonNegativeInt(record["input_tokens"]) +
    asNonNegativeInt(record["cache_creation_input_tokens"]);

  return {
    inputTokens: snakeCaseInput > 0 ? snakeCaseInput : asNonNegativeInt(record["inputTokens"]),
    cachedInputTokens:
      asNonNegativeInt(record["cache_read_input_tokens"]) ||
      asNonNegativeInt(record["cachedInputTokens"]),
    outputTokens:
      asNonNegativeInt(record["output_tokens"]) || asNonNegativeInt(record["outputTokens"]),
    reasoningOutputTokens:
      asNonNegativeInt(record["reasoning_output_tokens"]) ||
      asNonNegativeInt(record["reasoningOutputTokens"]),
  };
}

/** Turn cost as the provider reported it; anything non-finite or negative is dropped. */
export function normalizeTurnCostUsd(totalCostUsd: unknown): number {
  const numeric = asFiniteNumber(totalCostUsd);
  return numeric === null || numeric < 0 ? 0 : numeric;
}
