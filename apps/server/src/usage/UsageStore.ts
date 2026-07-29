/**
 * UsageStore - persistence and read model for provider-instance usage.
 *
 * Write side is fed by `ProviderRuntimeIngestion` as runtime events flow past;
 * read side folds the stored turns into per-instance day buckets for the
 * accounts panel. Both live behind one service because the fold is a SQL
 * `GROUP BY` over the table the writer owns, and splitting them would only add
 * a layer boundary between two halves of the same query.
 *
 * Every write returns `void` and swallows nothing: callers are expected to
 * treat usage as best-effort and catch, because losing a spend row must never
 * take down turn ingestion.
 *
 * @module UsageStore
 */
import {
  EMPTY_USAGE_TOTALS,
  type EnvironmentUsageSnapshot,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInstanceUsage,
  USAGE_RATE_WINDOW_MINUTES,
  USAGE_RETENTION_DAYS,
  USAGE_SNAPSHOT_DAYS,
  USAGE_WEEK_DAYS,
  UsageRateLimitSnapshot,
  type UsageTotals,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface RecordTurnUsageInput {
  readonly eventId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly completedAt: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface RecordRateLimitsInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly snapshot: UsageRateLimitSnapshot;
}

export interface UsageStoreShape {
  readonly recordTurn: (input: RecordTurnUsageInput) => Effect.Effect<void, PersistenceSqlError>;
  readonly recordRateLimits: (
    input: RecordRateLimitsInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly getSnapshot: () => Effect.Effect<EnvironmentUsageSnapshot, PersistenceSqlError>;
}

export class UsageStore extends Context.Service<UsageStore, UsageStoreShape>()(
  "t3/usage/UsageStore",
) {}

/** The aggregate columns every rollup query selects, whatever it groups by. */
interface TotalsRow {
  readonly provider_instance_id: string;
  readonly driver: string;
  readonly turns: number;
  readonly cost_usd: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
}

interface DayBucketRow extends TotalsRow {
  readonly day: string;
  readonly last_turn_at: string;
}

interface RateLimitRow {
  readonly provider_instance_id: string;
  readonly driver: string;
  readonly snapshot_json: string;
}

function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    turns: left.turns + right.turns,
    costUsd: left.costUsd + right.costUsd,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function rowTotals(row: TotalsRow): UsageTotals {
  return {
    turns: Math.round(row.turns),
    costUsd: row.cost_usd,
    inputTokens: Math.round(row.input_tokens),
    cachedInputTokens: Math.round(row.cached_input_tokens),
    outputTokens: Math.round(row.output_tokens),
    reasoningOutputTokens: Math.round(row.reasoning_output_tokens),
  };
}

/**
 * Day buckets are computed in the reporting machine's own zone: "spend today"
 * means the day the machine is having, and a hub reading four machines shows
 * four of those side by side rather than one arbitrary UTC day.
 */
const localZone = DateTime.zoneMakeLocal();

/** `YYYY-MM-DD` for an instant, in the process's local zone. */
function localDay(instant: DateTime.DateTime): string {
  return DateTime.formatIsoDate(DateTime.setZone(instant, localZone));
}

/** UTC ISO instant `days` before `instant`. */
function isoDaysBefore(instant: DateTime.DateTime, days: number): string {
  return DateTime.formatIso(DateTime.subtract(instant, { days }));
}

/** UTC ISO instant `minutes` before `instant`. */
function isoMinutesBefore(instant: DateTime.DateTime, minutes: number): string {
  return DateTime.formatIso(DateTime.subtract(instant, { minutes }));
}

const decodeRateLimitSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UsageRateLimitSnapshot),
);
const encodeRateLimitSnapshot = Schema.encodeEffect(Schema.fromJsonString(UsageRateLimitSnapshot));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordTurn: UsageStoreShape["recordTurn"] = (input) =>
    sql`
      INSERT OR IGNORE INTO fork_usage_turns (
        event_id,
        provider_instance_id,
        driver,
        thread_id,
        turn_id,
        completed_at,
        cost_usd,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens
      )
      VALUES (
        ${input.eventId},
        ${input.providerInstanceId},
        ${input.driver},
        ${input.threadId},
        ${input.turnId},
        ${input.completedAt},
        ${input.costUsd},
        ${input.inputTokens},
        ${input.cachedInputTokens},
        ${input.outputTokens},
        ${input.reasoningOutputTokens}
      )
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("usage.recordTurn")));

  const recordRateLimits: UsageStoreShape["recordRateLimits"] = (input) =>
    encodeRateLimitSnapshot(input.snapshot).pipe(
      // The value being encoded was just built by our own normalizer against
      // the same schema, so an encode failure here is a defect, not a
      // recoverable persistence error.
      Effect.orDie,
      Effect.flatMap(
        (snapshotJson) => sql`
          INSERT INTO fork_usage_rate_limits (
            provider_instance_id,
            driver,
            observed_at,
            snapshot_json
          )
          VALUES (
            ${input.providerInstanceId},
            ${input.driver},
            ${input.snapshot.observedAt},
            ${snapshotJson}
          )
          ON CONFLICT (provider_instance_id)
          DO UPDATE SET
            driver = excluded.driver,
            observed_at = excluded.observed_at,
            snapshot_json = excluded.snapshot_json
        `,
      ),
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("usage.recordRateLimits")),
    );

  const prune = (now: DateTime.DateTime) =>
    sql`
      DELETE FROM fork_usage_turns
      WHERE completed_at < ${isoDaysBefore(now, USAGE_RETENTION_DAYS)}
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("usage.prune")));

  const getSnapshot: UsageStoreShape["getSnapshot"] = () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const today = localDay(now);
      // Widened by a day past the window we report: `completed_at` is UTC and
      // the buckets are local, so a query cut at the UTC boundary would clip
      // the oldest local day depending on the sign of the offset.
      const since = isoDaysBefore(now, USAGE_SNAPSHOT_DAYS + 1);

      const dayRows = yield* sql<DayBucketRow>`
        SELECT
          provider_instance_id,
          driver,
          date(completed_at, 'localtime') AS day,
          COUNT(*) AS turns,
          SUM(cost_usd) AS cost_usd,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(reasoning_output_tokens) AS reasoning_output_tokens,
          MAX(completed_at) AS last_turn_at
        FROM fork_usage_turns
        WHERE completed_at >= ${since}
        GROUP BY provider_instance_id, driver, day
        ORDER BY day DESC
      `.pipe(Effect.mapError(toPersistenceSqlError("usage.readDayBuckets")));

      // Its own query rather than a fold over the day buckets: the window is
      // cut on the instant, and the day rows have already thrown away the
      // within-day timestamps this needs.
      const hourRows = yield* sql<TotalsRow>`
        SELECT
          provider_instance_id,
          driver,
          COUNT(*) AS turns,
          SUM(cost_usd) AS cost_usd,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(reasoning_output_tokens) AS reasoning_output_tokens
        FROM fork_usage_turns
        WHERE completed_at >= ${isoMinutesBefore(now, USAGE_RATE_WINDOW_MINUTES)}
        GROUP BY provider_instance_id, driver
      `.pipe(Effect.mapError(toPersistenceSqlError("usage.readRateWindow")));

      const rateLimitRows = yield* sql<RateLimitRow>`
        SELECT provider_instance_id, driver, snapshot_json
        FROM fork_usage_rate_limits
      `.pipe(Effect.mapError(toPersistenceSqlError("usage.readRateLimits")));

      const earliestReportedDay = localDay(
        DateTime.subtract(now, { days: USAGE_SNAPSHOT_DAYS - 1 }),
      );
      const earliestWeekDay = localDay(DateTime.subtract(now, { days: USAGE_WEEK_DAYS - 1 }));

      const byInstance = new Map<
        string,
        {
          driver: string;
          days: Array<{ day: string; totals: UsageTotals }>;
          today: UsageTotals;
          week: UsageTotals;
          lastTurnAt: string | null;
        }
      >();

      for (const row of dayRows) {
        if (row.day < earliestReportedDay) continue;
        const entry = byInstance.get(row.provider_instance_id) ?? {
          driver: row.driver,
          days: [],
          today: EMPTY_USAGE_TOTALS,
          week: EMPTY_USAGE_TOTALS,
          lastTurnAt: null,
        };
        const totals = rowTotals(row);
        entry.days.push({ day: row.day, totals });
        if (row.day === today) entry.today = addTotals(entry.today, totals);
        if (row.day >= earliestWeekDay) entry.week = addTotals(entry.week, totals);
        if (entry.lastTurnAt === null || row.last_turn_at > entry.lastTurnAt) {
          entry.lastTurnAt = row.last_turn_at;
        }
        byInstance.set(row.provider_instance_id, entry);
      }

      const lastHourByInstance = new Map<string, UsageTotals>();
      for (const row of hourRows) {
        lastHourByInstance.set(row.provider_instance_id, rowTotals(row));
        // Belt and braces: an instance whose day bucket was filtered out must
        // still appear, or the fleet rate would count spend that no row below
        // it accounts for.
        if (!byInstance.has(row.provider_instance_id)) {
          byInstance.set(row.provider_instance_id, {
            driver: row.driver,
            days: [],
            today: EMPTY_USAGE_TOTALS,
            week: EMPTY_USAGE_TOTALS,
            lastTurnAt: null,
          });
        }
      }

      const rateLimitsByInstance = new Map<string, UsageRateLimitSnapshot>();
      for (const row of rateLimitRows) {
        // A row written by an older fork build (or hand-edited) that no longer
        // decodes is dropped rather than failing the whole snapshot.
        const decoded = yield* decodeRateLimitSnapshot(row.snapshot_json).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("usage rate-limit snapshot could not be decoded", {
              providerInstanceId: row.provider_instance_id,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        if (decoded !== null) rateLimitsByInstance.set(row.provider_instance_id, decoded);
        if (!byInstance.has(row.provider_instance_id)) {
          byInstance.set(row.provider_instance_id, {
            driver: row.driver,
            days: [],
            today: EMPTY_USAGE_TOTALS,
            week: EMPTY_USAGE_TOTALS,
            lastTurnAt: null,
          });
        }
      }

      const instances: Array<ProviderInstanceUsage> = [...byInstance.entries()]
        .map(([providerInstanceId, entry]) => ({
          providerInstanceId: providerInstanceId as ProviderInstanceId,
          driver: entry.driver as ProviderDriverKind,
          rateLimits: rateLimitsByInstance.get(providerInstanceId) ?? null,
          today: entry.today,
          week: entry.week,
          lastHour: lastHourByInstance.get(providerInstanceId) ?? EMPTY_USAGE_TOTALS,
          days: entry.days,
          lastTurnAt: entry.lastTurnAt,
        }))
        .toSorted((left, right) => left.providerInstanceId.localeCompare(right.providerInstanceId));

      return {
        generatedAt: DateTime.formatIso(now),
        timeZone: localZone.id,
        today,
        instances,
        totalsToday: instances.reduce(
          (totals, instance) => addTotals(totals, instance.today),
          EMPTY_USAGE_TOTALS,
        ),
        totalsWeek: instances.reduce(
          (totals, instance) => addTotals(totals, instance.week),
          EMPTY_USAGE_TOTALS,
        ),
        totalsLastHour: [...lastHourByInstance.values()].reduce(addTotals, EMPTY_USAGE_TOTALS),
      } satisfies EnvironmentUsageSnapshot;
    });

  // One prune at construction. Retention is measured in months, so there is no
  // reason to pay for it on every write or to carry a scheduler for it.
  yield* DateTime.now.pipe(
    Effect.flatMap(prune),
    Effect.catchCause((cause) => Effect.logWarning("usage retention prune failed", { cause })),
  );

  return { recordTurn, recordRateLimits, getSnapshot } satisfies UsageStoreShape;
});

export const layer = Layer.effect(UsageStore, make);
