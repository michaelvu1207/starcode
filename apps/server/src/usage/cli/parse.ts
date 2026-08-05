// @effect-diagnostics nodeBuiltinImport:off - streams the CLIs' own session files;
// Effect's FileSystem service has no line-streaming primitive.
/**
 * Reading spend out of one CLI session file.
 *
 * Both parsers are shaped by the same two facts: these files are large (9 GB
 * across both stores on this machine) and almost none of their lines carry
 * usage. So every line is first tested with a substring scan and only the
 * survivors are handed to `JSON.parse` — the difference between decoding 2
 * million records and decoding the ~800,000 that count, and the reason a
 * 3.5 MB base64 image record costs a scan instead of an allocation.
 *
 * The two CLIs then diverge completely.
 *
 * **Claude** writes one record per assistant message with absolute token counts,
 * and writes the *same* message repeatedly as it streams — 144,000 records on
 * this machine collapse to 68,000 real messages. Deduplication is therefore not
 * an optimisation, it is correctness: skipping it doubles the reported spend.
 *
 * **Codex** writes per-turn deltas in `token_count` events and names the model
 * in a separate `turn_context` record that precedes them, so the parser is a
 * small state machine. Its deltas are not repeated, so there is nothing to
 * dedupe.
 *
 * @module CliUsageParse
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import type { CliUsageProvider } from "@starcode/contracts";
import * as DateTime from "effect/DateTime";

/** Tokens for one message, split the way the rate table prices them. */
export interface MessageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * A Claude message that survived in-file deduplication, still carrying the key
 * that lets a later pass drop copies of it living in *other* files.
 */
export interface KeyedMessage extends MessageTokens {
  readonly dedupKey: string;
  readonly day: string;
  readonly model: string;
}

/** Usage already folded to one day and model; nothing further can dedupe it. */
export interface UsageBucket extends MessageTokens {
  readonly day: string;
  readonly model: string;
  readonly messages: number;
}

export interface ParsedFileUsage {
  readonly keyed: ReadonlyArray<KeyedMessage>;
  readonly buckets: ReadonlyArray<UsageBucket>;
}

export const EMPTY_PARSED_FILE_USAGE: ParsedFileUsage = { keyed: [], buckets: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Buckets instants into `YYYY-MM-DD` in one zone.
 *
 * The zone defaults to the reporting machine's, matching how `UsageStore`
 * buckets the fork's own turns — so both halves of the panel agree about where
 * a day ends, and a machine reports the day it is actually having. Tests pass
 * an explicit zone so their expectations do not depend on the host's.
 */
export interface DayBucketer {
  /** Null for a missing or unparseable timestamp; the record is then skipped. */
  readonly fromIso: (iso: unknown) => string | null;
  readonly fromMillis: (millis: number) => string;
}

export const makeDayBucketer = (timeZone?: string): DayBucketer => {
  const zone =
    timeZone === undefined ? DateTime.zoneMakeLocal() : DateTime.zoneMakeNamedUnsafe(timeZone);
  const fromMillis = (millis: number): string =>
    DateTime.formatIsoDate(DateTime.setZone(DateTime.makeUnsafe(millis), zone));
  return {
    fromMillis,
    fromIso: (iso: unknown) => {
      if (typeof iso !== "string") return null;
      const millis = Date.parse(iso);
      return Number.isNaN(millis) ? null : fromMillis(millis);
    },
  };
};

const readLines = (path: string): NodeReadline.Interface =>
  NodeReadline.createInterface({
    input: NodeFS.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

/**
 * Cache-write tokens, preferring the nested breakdown over the flat field.
 *
 * Claude reports cache writes twice: a flat `cache_creation_input_tokens` and a
 * nested `cache_creation` object splitting them into 5-minute and 1-hour tiers,
 * which bill at different rates. Where both exist the nested one is
 * authoritative — there are records here whose flat field reads 0 while the
 * nested object reports thousands of 1-hour tokens, so trusting the flat field
 * both loses the tier and loses the tokens.
 */
const readClaudeCacheWrites = (
  usage: Record<string, unknown>,
): { readonly write5m: number; readonly write1h: number } => {
  const nested = usage["cache_creation"];
  if (isRecord(nested)) {
    return {
      write5m: asNumber(nested["ephemeral_5m_input_tokens"]),
      write1h: asNumber(nested["ephemeral_1h_input_tokens"]),
    };
  }
  return { write5m: asNumber(usage["cache_creation_input_tokens"]), write1h: 0 };
};

const totalTokens = (tokens: MessageTokens): number =>
  tokens.inputTokens +
  tokens.outputTokens +
  tokens.cacheWrite5mTokens +
  tokens.cacheWrite1hTokens +
  tokens.cacheReadTokens;

/**
 * Parses a Claude Code session file.
 *
 * Only `type: "assistant"` records carry usage — every one of the 143,000
 * usage-bearing records on this machine is one — and `<synthetic>` messages are
 * excluded because they are locally generated errors, not API calls.
 *
 * The in-file fold keeps, for each `(message.id, requestId)` pair, the single
 * record with the largest token total. Claude rewrites a message's row as it
 * streams, so the largest is the finished one; merging fields across copies
 * instead would invent a message that never happened.
 */
export const parseClaudeSessionFile = async (
  path: string,
  toDay: DayBucketer,
): Promise<ParsedFileUsage> => {
  const best = new Map<string, KeyedMessage>();
  const unkeyed: Array<UsageBucket> = [];

  for await (const line of readLines(path)) {
    // Both markers are required before paying for a decode. `"usage"` alone
    // appears in prose; `"assistant"` alone appears on every user record that
    // replies to one.
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A session being written to right now ends mid-record. Normal.
      continue;
    }
    if (!isRecord(record) || record["type"] !== "assistant") continue;

    const message = record["message"];
    if (!isRecord(message)) continue;
    const usage = message["usage"];
    if (!isRecord(usage)) continue;
    const model = message["model"];
    if (typeof model !== "string" || model.length === 0 || model === "<synthetic>") continue;
    const day = toDay.fromIso(record["timestamp"]);
    if (day === null) continue;

    const cacheWrites = readClaudeCacheWrites(usage);
    const tokens: MessageTokens = {
      inputTokens: asNumber(usage["input_tokens"]),
      outputTokens: asNumber(usage["output_tokens"]),
      cacheWrite5mTokens: cacheWrites.write5m,
      cacheWrite1hTokens: cacheWrites.write1h,
      cacheReadTokens: asNumber(usage["cache_read_input_tokens"]),
    };

    const messageId = message["id"];
    const requestId = record["requestId"];
    if (typeof messageId !== "string" || typeof requestId !== "string") {
      // Nothing identifies this row, so it can never be shown to be a copy of
      // another. Counting it is the safe direction.
      unkeyed.push({ day, model, messages: 1, ...tokens });
      continue;
    }

    const dedupKey = `${messageId}:${requestId}`;
    const previous = best.get(dedupKey);
    if (previous === undefined || totalTokens(tokens) > totalTokens(previous)) {
      best.set(dedupKey, { dedupKey, day, model, ...tokens });
    }
  }

  return { keyed: [...best.values()], buckets: unkeyed };
};

/**
 * Tokens from one Codex `last_token_usage` block.
 *
 * Codex counts the cached prefix inside `input_tokens`, so the cached part is
 * subtracted out to leave what was actually charged at the input rate. It bills
 * no cache writes, and `reasoning_output_tokens` is already inside
 * `output_tokens` — adding it would charge for the same tokens twice.
 */
const readCodexTokens = (usage: Record<string, unknown>): MessageTokens => {
  const cached = asNumber(usage["cached_input_tokens"]) || asNumber(usage["cached_tokens"]);
  const rawInput = asNumber(usage["input_tokens"]) || asNumber(usage["prompt_tokens"]);
  return {
    inputTokens: Math.max(0, rawInput - cached),
    outputTokens: asNumber(usage["output_tokens"]) || asNumber(usage["completion_tokens"]),
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: cached,
  };
};

const addBucket = (
  into: Map<string, UsageBucket>,
  day: string,
  model: string,
  tokens: MessageTokens,
): void => {
  const key = `${day} ${model}`;
  const previous = into.get(key);
  into.set(
    key,
    previous === undefined
      ? { day, model, messages: 1, ...tokens }
      : {
          day,
          model,
          messages: previous.messages + 1,
          inputTokens: previous.inputTokens + tokens.inputTokens,
          outputTokens: previous.outputTokens + tokens.outputTokens,
          cacheWrite5mTokens: previous.cacheWrite5mTokens + tokens.cacheWrite5mTokens,
          cacheWrite1hTokens: previous.cacheWrite1hTokens + tokens.cacheWrite1hTokens,
          cacheReadTokens: previous.cacheReadTokens + tokens.cacheReadTokens,
        },
  );
};

/** Stands in for a Codex turn whose `turn_context` never named a model. */
export const CODEX_UNKNOWN_MODEL = "unknown";

/**
 * Parses a Codex rollout file.
 *
 * `turn_context` is discriminated on the *record's* type, not the payload's —
 * its payload is a bare settings object with no `type` of its own — and it
 * names the model every following turn bills against until the next one
 * appears. `token_count` events then carry per-turn deltas in
 * `info.last_token_usage`, which sum exactly to the session's final
 * `total_token_usage`.
 *
 * Results are folded per day and model as they are read. Codex writes each
 * delta once, so there is nothing a later pass could deduplicate, and folding
 * here keeps a 250,000-record rollout out of the cache.
 */
export const parseCodexSessionFile = async (
  path: string,
  toDay: DayBucketer,
): Promise<ParsedFileUsage> => {
  const buckets = new Map<string, UsageBucket>();
  let model = CODEX_UNKNOWN_MODEL;

  for await (const line of readLines(path)) {
    const isTokenCount = line.includes('"token_count"');
    const isTurnContext = !isTokenCount && line.includes('"turn_context"');
    if (!isTokenCount && !isTurnContext) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    const payload = record["payload"];
    if (!isRecord(payload)) continue;

    if (record["type"] === "turn_context") {
      const next = payload["model"];
      if (typeof next === "string" && next.length > 0) model = next;
      continue;
    }

    if (record["type"] !== "event_msg" || payload["type"] !== "token_count") continue;
    const info = payload["info"];
    if (!isRecord(info)) continue;
    const last = info["last_token_usage"];
    if (!isRecord(last)) continue;
    const day = toDay.fromIso(record["timestamp"]);
    if (day === null) continue;

    const tokens = readCodexTokens(last);
    // A turn that moved no tokens is a heartbeat, not spend.
    if (totalTokens(tokens) === 0) continue;
    addBucket(buckets, day, model, tokens);
  }

  return { keyed: [], buckets: [...buckets.values()] };
};

export const parseSessionFile = (
  provider: CliUsageProvider,
  path: string,
  toDay: DayBucketer,
): Promise<ParsedFileUsage> =>
  provider === "claude" ? parseClaudeSessionFile(path, toDay) : parseCodexSessionFile(path, toDay);
