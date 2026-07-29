import { assert, describe, it } from "@effect/vitest";

import { aggregateCliUsage, type ProviderFileUsage } from "./aggregate.ts";
import type { KeyedMessage, UsageBucket } from "./parse.ts";

const options = {
  today: "2026-07-25",
  earliest7Day: "2026-07-19",
  earliest30Day: "2026-06-26",
  codexPriorityTier: false,
};

const keyed = (fields: {
  readonly dedupKey: string;
  readonly day?: string;
  readonly model?: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheWrite1h?: number;
  readonly cacheRead?: number;
}): KeyedMessage => ({
  dedupKey: fields.dedupKey,
  day: fields.day ?? "2026-07-25",
  model: fields.model ?? "claude-opus-5",
  inputTokens: fields.input ?? 0,
  outputTokens: fields.output ?? 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: fields.cacheWrite1h ?? 0,
  cacheReadTokens: fields.cacheRead ?? 0,
});

const bucket = (fields: {
  readonly day?: string;
  readonly model: string;
  readonly messages?: number;
  readonly input?: number;
  readonly output?: number;
}): UsageBucket => ({
  day: fields.day ?? "2026-07-25",
  model: fields.model,
  messages: fields.messages ?? 1,
  inputTokens: fields.input ?? 0,
  outputTokens: fields.output ?? 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
});

const claudeFile = (
  messages: ReadonlyArray<KeyedMessage>,
  buckets: ReadonlyArray<UsageBucket> = [],
): ProviderFileUsage => ({ provider: "claude", parsed: { keyed: messages, buckets } });

const codexFile = (buckets: ReadonlyArray<UsageBucket>): ProviderFileUsage => ({
  provider: "codex",
  parsed: { keyed: [], buckets },
});

const providerNamed = (result: ReturnType<typeof aggregateCliUsage>, provider: string) =>
  result.providers.find((entry) => entry.provider === provider);

describe("aggregateCliUsage", () => {
  it("drops a message duplicated across two files, keeping the largest copy", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([keyed({ dedupKey: "msg_1:req_1", output: 100 })]),
        // A resumed session replays the earlier message into its own file.
        claudeFile([keyed({ dedupKey: "msg_1:req_1", output: 250 })]),
      ],
      options,
    );

    const claude = providerNamed(result, "claude");
    assert.strictEqual(claude?.allTime.messages, 1);
    assert.strictEqual(claude?.allTime.outputTokens, 250);
  });

  it("keeps the two providers' dedup pools apart", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([keyed({ dedupKey: "shared", output: 10 })]),
        {
          provider: "codex",
          parsed: { keyed: [keyed({ dedupKey: "shared", output: 20 })], buckets: [] },
        },
      ],
      options,
    );
    assert.strictEqual(providerNamed(result, "claude")?.allTime.messages, 1);
    assert.strictEqual(providerNamed(result, "codex")?.allTime.messages, 1);
  });

  it("counts a message in every window that contains it", () => {
    const result = aggregateCliUsage(
      [claudeFile([keyed({ dedupKey: "a", day: "2026-07-25", output: 1_000_000 })])],
      options,
    );
    const claude = providerNamed(result, "claude");
    assert.strictEqual(claude?.today.messages, 1);
    assert.strictEqual(claude?.last7Days.messages, 1);
    assert.strictEqual(claude?.last30Days.messages, 1);
    assert.strictEqual(claude?.allTime.messages, 1);
  });

  it("excludes a message from the windows that predate it", () => {
    const result = aggregateCliUsage(
      [claudeFile([keyed({ dedupKey: "a", day: "2026-05-01", output: 10 })])],
      options,
    );
    const claude = providerNamed(result, "claude");
    assert.strictEqual(claude?.today.messages, 0);
    assert.strictEqual(claude?.last7Days.messages, 0);
    assert.strictEqual(claude?.last30Days.messages, 0);
    assert.strictEqual(claude?.allTime.messages, 1);
  });

  it("counts an unpriced model's tokens while refusing to price them", () => {
    const result = aggregateCliUsage(
      [codexFile([bucket({ model: "gpt-5.6-sol", messages: 4, input: 5_000, output: 500 })])],
      options,
    );

    const codex = providerNamed(result, "codex");
    assert.strictEqual(codex?.allTime.costUsd, 0);
    assert.strictEqual(codex?.allTime.inputTokens, 5_000);
    assert.strictEqual(codex?.allTime.messages, 4);
    assert.strictEqual(codex?.allTime.unpricedMessages, 4);
    assert.strictEqual(codex?.models[0]?.priced, false);
  });

  it("reports a partly unpriced provider's cost as a floor", () => {
    const result = aggregateCliUsage(
      [
        codexFile([
          bucket({ model: "gpt-5.5", messages: 1, output: 1_000_000 }),
          bucket({ model: "gpt-5.6-sol", messages: 3, output: 1_000_000 }),
        ]),
      ],
      options,
    );

    const codex = providerNamed(result, "codex");
    assert.strictEqual(Math.round((codex?.allTime.costUsd ?? 0) * 100) / 100, 30);
    assert.strictEqual(codex?.allTime.messages, 4);
    assert.strictEqual(codex?.allTime.unpricedMessages, 3);
  });

  it("prices a pre-folded bucket once over its summed tokens", () => {
    const single = aggregateCliUsage(
      [codexFile([bucket({ model: "gpt-5.5", messages: 1, output: 3_000_000 })])],
      options,
    );
    const folded = aggregateCliUsage(
      [codexFile([bucket({ model: "gpt-5.5", messages: 3, output: 3_000_000 })])],
      options,
    );
    assert.strictEqual(
      providerNamed(single, "codex")?.allTime.costUsd,
      providerNamed(folded, "codex")?.allTime.costUsd,
    );
  });

  it("applies the priority multiplier only to Codex", () => {
    const standard = aggregateCliUsage(
      [codexFile([bucket({ model: "gpt-5.5", output: 1_000_000 })])],
      options,
    );
    const priority = aggregateCliUsage(
      [codexFile([bucket({ model: "gpt-5.5", output: 1_000_000 })])],
      { ...options, codexPriorityTier: true },
    );
    assert.strictEqual(
      providerNamed(priority, "codex")?.allTime.costUsd,
      (providerNamed(standard, "codex")?.allTime.costUsd ?? 0) * 2.5,
    );
  });

  it("bills the one-hour cache tier above the five-minute one", () => {
    const result = aggregateCliUsage(
      [claudeFile([keyed({ dedupKey: "a", model: "claude-opus-5", cacheWrite1h: 1_000_000 })])],
      options,
    );
    // 1M one-hour cache-write tokens at $10/M.
    assert.strictEqual(
      Math.round((providerNamed(result, "claude")?.allTime.costUsd ?? 0) * 100) / 100,
      10,
    );
    assert.strictEqual(providerNamed(result, "claude")?.allTime.cacheWriteTokens, 1_000_000);
  });

  it("orders models by cost, so a truncated render shows what dominates", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([
          keyed({ dedupKey: "a", model: "claude-sonnet-5", output: 1_000_000 }),
          keyed({ dedupKey: "b", model: "claude-fable-5", output: 1_000_000 }),
          keyed({ dedupKey: "c", model: "claude-haiku-4-5", output: 1_000_000 }),
        ]),
      ],
      options,
    );
    assert.deepStrictEqual(
      providerNamed(result, "claude")?.models.map((model) => model.model),
      ["claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5"],
    );
  });

  it("reports the day range and file count it actually saw", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([keyed({ dedupKey: "a", day: "2026-06-10", output: 1 })]),
        claudeFile([keyed({ dedupKey: "b", day: "2026-07-25", output: 1 })]),
      ],
      options,
    );
    const claude = providerNamed(result, "claude");
    assert.strictEqual(claude?.firstDay, "2026-06-10");
    assert.strictEqual(claude?.lastDay, "2026-07-25");
    assert.strictEqual(claude?.sessionFiles, 2);
  });

  it("sums provider all-time totals into the grand total", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([keyed({ dedupKey: "a", output: 1_000_000, model: "claude-opus-5" })]),
        codexFile([bucket({ model: "gpt-5.5", output: 1_000_000 })]),
      ],
      options,
    );
    // $25 of Claude output plus $30 of Codex output.
    assert.strictEqual(Math.round(result.totals.costUsd * 100) / 100, 55);
    assert.strictEqual(result.totals.messages, 2);
  });

  it("returns no providers for an empty store rather than zeroed ones", () => {
    const result = aggregateCliUsage([], options);
    assert.lengthOf(result.providers, 0);
    assert.strictEqual(result.totals.costUsd, 0);
  });

  it("buckets a day series over the 30-day window only, ascending", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([
          keyed({ dedupKey: "a", day: "2026-07-25", model: "claude-opus-5", output: 1_000_000 }),
          keyed({ dedupKey: "b", day: "2026-07-01", model: "claude-opus-5", output: 1_000_000 }),
          // Outside the window: counted in all-time, absent from the series.
          keyed({ dedupKey: "c", day: "2026-05-01", model: "claude-opus-5", output: 1_000_000 }),
        ]),
      ],
      options,
    );

    const claude = providerNamed(result, "claude");
    assert.deepStrictEqual(
      claude?.days?.map((day) => day.day),
      ["2026-07-01", "2026-07-25"],
    );
    assert.strictEqual(claude?.days?.[0]?.messages, 1);
    assert.strictEqual(claude?.allTime.messages, 3);
    assert.strictEqual(claude?.last30Days.messages, 2);
  });

  it("sums a day's spend across the files that touched it", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([keyed({ dedupKey: "a", day: "2026-07-20", output: 1_000_000 })]),
        claudeFile([keyed({ dedupKey: "b", day: "2026-07-20", output: 1_000_000 })]),
      ],
      options,
    );

    const day = providerNamed(result, "claude")?.days?.find((entry) => entry.day === "2026-07-20");
    assert.strictEqual(day?.messages, 2);
    // 2M output tokens of claude-opus-5 at $25/M.
    assert.strictEqual(Math.round((day?.costUsd ?? 0) * 100) / 100, 50);
  });

  it("splits a model's totals by window, so a 30-day breakdown is not all-time", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([
          keyed({ dedupKey: "a", day: "2026-07-25", model: "claude-opus-5", output: 1_000_000 }),
          keyed({ dedupKey: "b", day: "2026-01-05", model: "claude-opus-5", output: 3_000_000 }),
        ]),
      ],
      options,
    );

    const model = providerNamed(result, "claude")?.models[0];
    assert.strictEqual(model?.model, "claude-opus-5");
    assert.strictEqual(model?.totals.outputTokens, 4_000_000);
    assert.strictEqual(model?.last30Days?.outputTokens, 1_000_000);
    assert.strictEqual(model?.last30Days?.messages, 1);
  });

  it("gives a model that only ever ran outside the window a zeroed 30 days", () => {
    const result = aggregateCliUsage(
      [claudeFile([keyed({ dedupKey: "a", day: "2025-12-01", output: 1_000_000 })])],
      options,
    );

    const model = providerNamed(result, "claude")?.models[0];
    assert.strictEqual(model?.totals.messages, 1);
    assert.strictEqual(model?.last30Days?.messages, 0);
    assert.strictEqual(model?.last30Days?.costUsd, 0);
    assert.deepStrictEqual(providerNamed(result, "claude")?.days, []);
  });

  it("dedups before bucketing, so a replayed message is one day's spend", () => {
    const result = aggregateCliUsage(
      [
        claudeFile([keyed({ dedupKey: "msg_1:req_1", day: "2026-07-20", output: 100 })]),
        claudeFile([keyed({ dedupKey: "msg_1:req_1", day: "2026-07-20", output: 250 })]),
      ],
      options,
    );

    const days = providerNamed(result, "claude")?.days;
    assert.lengthOf(days ?? [], 1);
    assert.strictEqual(days?.[0]?.messages, 1);
  });
});
