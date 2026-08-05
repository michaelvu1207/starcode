import { assert, describe, it } from "@effect/vitest";
import type { ProviderDriverKind, ProviderInstanceId } from "@starcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as UsageStoreLive, UsageStore, type UsageStoreShape } from "./UsageStore.ts";

const claude = "claude" as ProviderDriverKind;
const personal = "claude-personal" as ProviderInstanceId;
const work = "claude-work" as ProviderInstanceId;

// Timestamps come from the same clock the store reads, so local-day bucketing
// is exercised without the test depending on the machine's time zone.
const withStore = <A, E>(use: (store: UsageStoreShape, now: DateTime.Utc) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const store = yield* Effect.service(UsageStore);
    const now = yield* DateTime.now;
    return yield* use(store, now);
  }).pipe(Effect.provide(UsageStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))));

const turn = (
  overrides: Partial<Parameters<UsageStoreShape["recordTurn"]>[0]> & {
    readonly eventId: string;
    readonly completedAt: string;
  },
) => ({
  providerInstanceId: personal,
  driver: claude,
  threadId: "thread-1",
  turnId: "turn-1",
  costUsd: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  ...overrides,
});

describe("UsageStore", () => {
  it.effect("folds turns into today's totals per instance", () =>
    withStore((store, now) =>
      Effect.gen(function* () {
        const completedAt = DateTime.formatIso(now);
        yield* store.recordTurn(
          turn({ eventId: "e1", completedAt, costUsd: 0.25, inputTokens: 100 }),
        );
        yield* store.recordTurn(
          turn({ eventId: "e2", completedAt, costUsd: 0.75, outputTokens: 40 }),
        );
        yield* store.recordTurn(
          turn({
            eventId: "e3",
            completedAt,
            providerInstanceId: work,
            costUsd: 2,
            inputTokens: 7,
          }),
        );

        const snapshot = yield* store.getSnapshot();

        assert.strictEqual(snapshot.instances.length, 2);
        assert.strictEqual(snapshot.totalsToday.costUsd, 3);
        assert.strictEqual(snapshot.totalsToday.turns, 3);

        const personalUsage = snapshot.instances.find(
          (instance) => instance.providerInstanceId === personal,
        );
        assert.strictEqual(personalUsage?.today.costUsd, 1);
        assert.strictEqual(personalUsage?.today.inputTokens, 100);
        assert.strictEqual(personalUsage?.today.outputTokens, 40);
        assert.strictEqual(personalUsage?.days.length, 1);
        assert.strictEqual(personalUsage?.days[0]?.day, snapshot.today);
      }),
    ),
  );

  it.effect("counts a replayed event once", () =>
    withStore((store, now) =>
      Effect.gen(function* () {
        const completedAt = DateTime.formatIso(now);
        yield* store.recordTurn(turn({ eventId: "same", completedAt, costUsd: 1.5 }));
        yield* store.recordTurn(turn({ eventId: "same", completedAt, costUsd: 1.5 }));

        const snapshot = yield* store.getSnapshot();
        assert.strictEqual(snapshot.totalsToday.turns, 1);
        assert.strictEqual(snapshot.totalsToday.costUsd, 1.5);
      }),
    ),
  );

  it.effect("keeps older turns out of today, inside the week, and past the window", () =>
    withStore((store, now) =>
      Effect.gen(function* () {
        const daysAgo = (days: number) => DateTime.formatIso(DateTime.subtract(now, { days }));
        yield* store.recordTurn(turn({ eventId: "today", completedAt: daysAgo(0), costUsd: 1 }));
        yield* store.recordTurn(
          turn({ eventId: "three-days-ago", completedAt: daysAgo(3), costUsd: 4 }),
        );
        yield* store.recordTurn(
          turn({ eventId: "thirty-days-ago", completedAt: daysAgo(30), costUsd: 9 }),
        );

        const snapshot = yield* store.getSnapshot();
        assert.strictEqual(snapshot.totalsToday.costUsd, 1);
        assert.strictEqual(snapshot.totalsWeek.costUsd, 5);
        // The 30-day-old turn is outside the reported window entirely.
        assert.strictEqual(snapshot.instances[0]?.days.length, 2);
      }),
    ),
  );

  it.effect("cuts the hourly window on the instant, not on the day", () =>
    withStore((store, now) =>
      Effect.gen(function* () {
        const minutesAgo = (minutes: number) =>
          DateTime.formatIso(DateTime.subtract(now, { minutes }));
        yield* store.recordTurn(
          turn({ eventId: "just-now", completedAt: minutesAgo(1), costUsd: 2, inputTokens: 30 }),
        );
        yield* store.recordTurn(
          turn({ eventId: "in-window", completedAt: minutesAgo(59), costUsd: 1, outputTokens: 5 }),
        );
        // Ninety minutes back is still today — the day totals keep it, the
        // hourly window must not.
        yield* store.recordTurn(
          turn({ eventId: "too-old", completedAt: minutesAgo(90), costUsd: 8 }),
        );
        yield* store.recordTurn(
          turn({
            eventId: "other-instance",
            completedAt: minutesAgo(5),
            providerInstanceId: work,
            costUsd: 0.5,
          }),
        );

        const snapshot = yield* store.getSnapshot();
        assert.strictEqual(snapshot.totalsLastHour?.costUsd, 3.5);
        assert.strictEqual(snapshot.totalsLastHour?.turns, 3);
        assert.strictEqual(snapshot.totalsLastHour?.inputTokens, 30);
        assert.strictEqual(snapshot.totalsLastHour?.outputTokens, 5);
        assert.strictEqual(snapshot.totalsToday.costUsd, 11.5);

        const personalUsage = snapshot.instances.find(
          (instance) => instance.providerInstanceId === personal,
        );
        assert.strictEqual(personalUsage?.lastHour?.costUsd, 3);
        assert.strictEqual(personalUsage?.lastHour?.turns, 2);
      }),
    ),
  );

  it.effect("reports a zeroed hourly window when nothing ran in it", () =>
    withStore((store, now) =>
      Effect.gen(function* () {
        yield* store.recordTurn(
          turn({
            eventId: "hours-ago",
            completedAt: DateTime.formatIso(DateTime.subtract(now, { minutes: 200 })),
            costUsd: 4,
          }),
        );

        const snapshot = yield* store.getSnapshot();
        // Present and zero, never absent: absence is how a client detects a
        // server that predates the window at all.
        assert.isDefined(snapshot.totalsLastHour);
        assert.strictEqual(snapshot.totalsLastHour?.turns, 0);
        assert.strictEqual(snapshot.instances[0]?.lastHour?.costUsd, 0);
      }),
    ),
  );

  it.effect("keeps only the latest rate-limit snapshot per instance", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.recordRateLimits({
          providerInstanceId: personal,
          driver: claude,
          snapshot: {
            status: "allowed",
            planLabel: null,
            windows: [
              {
                key: "five_hour",
                label: "Five hour",
                usedPercent: 10,
                resetsAt: null,
                windowMinutes: null,
              },
            ],
            observedAt: "2026-07-24T10:00:00.000Z",
          },
        });
        yield* store.recordRateLimits({
          providerInstanceId: personal,
          driver: claude,
          snapshot: {
            status: "warning",
            planLabel: "max",
            windows: [
              {
                key: "five_hour",
                label: "Five hour",
                usedPercent: 91,
                resetsAt: "2026-07-24T15:00:00.000Z",
                windowMinutes: 300,
              },
            ],
            observedAt: "2026-07-24T14:00:00.000Z",
          },
        });

        const snapshot = yield* store.getSnapshot();
        const usage = snapshot.instances[0];
        assert.strictEqual(usage?.providerInstanceId, personal);
        assert.strictEqual(usage?.rateLimits?.status, "warning");
        assert.strictEqual(usage?.rateLimits?.windows[0]?.usedPercent, 91);
        // An instance known only from a rate-limit event still appears, with
        // zeroed spend rather than being hidden.
        assert.strictEqual(usage?.today.turns, 0);
      }),
    ),
  );

  it.effect("reports an empty snapshot before anything has been recorded", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const snapshot = yield* store.getSnapshot();
        assert.deepStrictEqual(snapshot.instances, []);
        assert.strictEqual(snapshot.totalsToday.costUsd, 0);
        assert.isTrue(snapshot.timeZone.length > 0);
      }),
    ),
  );
});
