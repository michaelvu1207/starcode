// @effect-diagnostics nodeBuiltinImport:off - writes real session fixtures, because
// the parsers stream files rather than take strings.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { makeDayBucketer, parseClaudeSessionFile, parseCodexSessionFile } from "./parse.ts";

/** Fixed zone so day boundaries do not depend on where the test runs. */
const toDay = makeDayBucketer("UTC");

const withSessionFile = async <A>(
  lines: ReadonlyArray<string>,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-cli-usage-"));
  const path = NodePath.join(directory, "session.jsonl");
  await NodeFSP.writeFile(path, `${lines.join("\n")}\n`, "utf8");
  try {
    return await use(path);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

const claudeRecord = (fields: {
  readonly id: string;
  readonly requestId?: string;
  readonly model?: string;
  readonly timestamp?: string;
  readonly usage: Record<string, unknown>;
  readonly type?: string;
}): string =>
  JSON.stringify({
    type: fields.type ?? "assistant",
    timestamp: fields.timestamp ?? "2026-07-20T12:00:00.000Z",
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
    message: {
      id: fields.id,
      model: fields.model ?? "claude-opus-5",
      usage: fields.usage,
    },
  });

describe("makeDayBucketer", () => {
  it("buckets an instant into the requested zone", () => {
    // 03:00 UTC is still the previous day in Los Angeles.
    assert.strictEqual(toDay.fromIso("2026-07-20T03:00:00.000Z"), "2026-07-20");
    assert.strictEqual(
      makeDayBucketer("America/Los_Angeles").fromIso("2026-07-20T03:00:00.000Z"),
      "2026-07-19",
    );
  });

  it("returns null for a missing or unparseable timestamp", () => {
    assert.isNull(toDay.fromIso(undefined));
    assert.isNull(toDay.fromIso(42));
    assert.isNull(toDay.fromIso("not a date"));
  });
});

describe("parseClaudeSessionFile", () => {
  it("keeps the largest copy of a repeated message rather than summing it", async () => {
    const result = await withSessionFile(
      [
        claudeRecord({ id: "msg_1", requestId: "req_1", usage: { output_tokens: 10 } }),
        claudeRecord({ id: "msg_1", requestId: "req_1", usage: { output_tokens: 250 } }),
        claudeRecord({ id: "msg_1", requestId: "req_1", usage: { output_tokens: 120 } }),
      ],
      (path) => parseClaudeSessionFile(path, toDay),
    );

    assert.lengthOf(result.keyed, 1);
    assert.strictEqual(result.keyed[0]?.outputTokens, 250);
  });

  it("treats the same message id under a different request as a separate message", async () => {
    const result = await withSessionFile(
      [
        claudeRecord({ id: "msg_1", requestId: "req_1", usage: { output_tokens: 10 } }),
        claudeRecord({ id: "msg_1", requestId: "req_2", usage: { output_tokens: 20 } }),
      ],
      (path) => parseClaudeSessionFile(path, toDay),
    );
    assert.lengthOf(result.keyed, 2);
  });

  it("prefers the nested cache breakdown over the flat field", async () => {
    const result = await withSessionFile(
      [
        claudeRecord({
          id: "msg_1",
          requestId: "req_1",
          usage: {
            // The flat field disagrees with the nested one; real records do
            // this, and the nested one is authoritative.
            cache_creation_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 100,
              ephemeral_1h_input_tokens: 2_623,
            },
          },
        }),
      ],
      (path) => parseClaudeSessionFile(path, toDay),
    );

    assert.strictEqual(result.keyed[0]?.cacheWrite5mTokens, 100);
    assert.strictEqual(result.keyed[0]?.cacheWrite1hTokens, 2_623);
  });

  it("falls back to the flat cache field when there is no nested one", async () => {
    const result = await withSessionFile(
      [
        claudeRecord({
          id: "msg_1",
          requestId: "req_1",
          usage: { cache_creation_input_tokens: 500 },
        }),
      ],
      (path) => parseClaudeSessionFile(path, toDay),
    );
    assert.strictEqual(result.keyed[0]?.cacheWrite5mTokens, 500);
    assert.strictEqual(result.keyed[0]?.cacheWrite1hTokens, 0);
  });

  it("counts a record that identifies no message rather than dropping it", async () => {
    const result = await withSessionFile(
      [claudeRecord({ id: "msg_1", usage: { output_tokens: 7 } })],
      (path) => parseClaudeSessionFile(path, toDay),
    );
    assert.lengthOf(result.keyed, 0);
    assert.lengthOf(result.buckets, 1);
    assert.strictEqual(result.buckets[0]?.outputTokens, 7);
    assert.strictEqual(result.buckets[0]?.messages, 1);
  });

  it("ignores synthetic messages, non-assistant records and malformed lines", async () => {
    const result = await withSessionFile(
      [
        claudeRecord({
          id: "msg_1",
          requestId: "req_1",
          model: "<synthetic>",
          usage: { output_tokens: 999 },
        }),
        claudeRecord({
          id: "msg_2",
          requestId: "req_2",
          type: "user",
          usage: { output_tokens: 999 },
        }),
        '{"type":"assistant","message":{"usage":{"output_tokens":1',
        "",
        claudeRecord({ id: "msg_3", requestId: "req_3", usage: { output_tokens: 5 } }),
      ],
      (path) => parseClaudeSessionFile(path, toDay),
    );

    assert.lengthOf(result.keyed, 1);
    assert.strictEqual(result.keyed[0]?.dedupKey, "msg_3:req_3");
  });
});

const codexTokenCount = (fields: {
  readonly timestamp?: string;
  readonly input: number;
  readonly cached?: number;
  readonly output: number;
  readonly reasoning?: number;
}): string =>
  JSON.stringify({
    timestamp: fields.timestamp ?? "2026-07-20T12:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: fields.input,
          cached_input_tokens: fields.cached ?? 0,
          output_tokens: fields.output,
          reasoning_output_tokens: fields.reasoning ?? 0,
        },
      },
    },
  });

const codexTurnContext = (model: string): string =>
  JSON.stringify({
    timestamp: "2026-07-20T11:59:00.000Z",
    type: "turn_context",
    payload: { cwd: "/tmp", model },
  });

describe("parseCodexSessionFile", () => {
  it("attributes turns to the model named by the preceding turn_context", async () => {
    const result = await withSessionFile(
      [
        codexTurnContext("gpt-5.5"),
        codexTokenCount({ input: 100, output: 10 }),
        codexTurnContext("gpt-5.4"),
        codexTokenCount({ input: 200, output: 20 }),
      ],
      (path) => parseCodexSessionFile(path, toDay),
    );

    const byModel = new Map(result.buckets.map((bucket) => [bucket.model, bucket]));
    assert.strictEqual(byModel.get("gpt-5.5")?.inputTokens, 100);
    assert.strictEqual(byModel.get("gpt-5.4")?.inputTokens, 200);
  });

  it("subtracts the cached prefix out of the input count", async () => {
    const result = await withSessionFile(
      [codexTurnContext("gpt-5.5"), codexTokenCount({ input: 1_000, cached: 800, output: 50 })],
      (path) => parseCodexSessionFile(path, toDay),
    );
    assert.strictEqual(result.buckets[0]?.inputTokens, 200);
    assert.strictEqual(result.buckets[0]?.cacheReadTokens, 800);
  });

  it("does not add reasoning tokens on top of output tokens", async () => {
    const result = await withSessionFile(
      [codexTurnContext("gpt-5.5"), codexTokenCount({ input: 10, output: 100, reasoning: 60 })],
      (path) => parseCodexSessionFile(path, toDay),
    );
    assert.strictEqual(result.buckets[0]?.outputTokens, 100);
  });

  it("folds turns into one bucket per day and model", async () => {
    const result = await withSessionFile(
      [
        codexTurnContext("gpt-5.5"),
        codexTokenCount({ input: 10, output: 1, timestamp: "2026-07-20T01:00:00.000Z" }),
        codexTokenCount({ input: 20, output: 2, timestamp: "2026-07-20T02:00:00.000Z" }),
        codexTokenCount({ input: 40, output: 4, timestamp: "2026-07-21T02:00:00.000Z" }),
      ],
      (path) => parseCodexSessionFile(path, toDay),
    );

    assert.lengthOf(result.buckets, 2);
    const first = result.buckets.find((bucket) => bucket.day === "2026-07-20");
    assert.strictEqual(first?.messages, 2);
    assert.strictEqual(first?.inputTokens, 30);
  });

  it("skips heartbeat turns that moved no tokens", async () => {
    const result = await withSessionFile(
      [codexTurnContext("gpt-5.5"), codexTokenCount({ input: 0, output: 0 })],
      (path) => parseCodexSessionFile(path, toDay),
    );
    assert.lengthOf(result.buckets, 0);
  });

  it("records turns that never named a model under the unknown bucket", async () => {
    const result = await withSessionFile([codexTokenCount({ input: 10, output: 1 })], (path) =>
      parseCodexSessionFile(path, toDay),
    );
    assert.strictEqual(result.buckets[0]?.model, "unknown");
  });

  it("produces nothing a later pass could deduplicate", async () => {
    const result = await withSessionFile(
      [codexTurnContext("gpt-5.5"), codexTokenCount({ input: 10, output: 1 })],
      (path) => parseCodexSessionFile(path, toDay),
    );
    assert.lengthOf(result.keyed, 0);
  });
});
