import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration041 from "./041_ProjectionAgentRuns.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

interface AgentRunRow {
  readonly parentThreadId: string;
  readonly provider: string;
  readonly agentRunId: string;
  readonly launchToolUseId: string | null;
  readonly taskType: string | null;
  readonly agentType: string | null;
  readonly model: string | null;
  readonly description: string | null;
  readonly status: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly historySessionId: string | null;
  readonly transcriptState: string;
  readonly parentNativeSessionId: string | null;
}

layer("041_ProjectionAgentRuns", (it) => {
  it.effect(
    "backfills owned agents, folds untyped terminal rows, excludes Bash, and checkpoints the tip",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 40 });

        const appendActivity = (
          sequence: number,
          threadId: string,
          kind: string,
          createdAt: string,
          payload: Readonly<Record<string, unknown>>,
        ) => {
          const eventPayload = {
            threadId,
            activity: {
              id: `activity-${sequence}`,
              tone: "info",
              kind,
              summary: kind,
              payload,
              turnId: null,
              createdAt,
            },
          };
          return sql`
            INSERT INTO orchestration_events (
              sequence,
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              actor_kind,
              command_id,
              causation_event_id,
              correlation_id,
              payload_json,
              metadata_json
            )
            VALUES (
              ${sequence},
              ${`event-${sequence}`},
              'thread',
              ${threadId},
              ${sequence},
              'thread.activity-appended',
              ${createdAt},
              'provider',
              NULL,
              NULL,
              NULL,
              ${JSON.stringify(eventPayload)},
              '{}'
            )
          `;
        };

        yield* appendActivity(1, "thread-claude", "task.started", "2026-07-30T20:00:00.000Z", {
          taskId: "claude-agent",
          taskType: "local_agent",
          toolUseId: "tool-claude",
          subagentType: "Explore",
          model: "opus",
          detail: "Inspect the repository",
          parentNativeSessionId: "native-parent",
        });
        yield* appendActivity(2, "thread-codex", "task.started", "2026-07-30T20:01:00.000Z", {
          taskId: "codex-cli:tool-codex",
          taskType: "codex_cli",
          toolUseId: "tool-codex",
          subagentType: "Codex CLI",
          model: "gpt-5.6-sol",
          title: "Verify the build",
        });
        yield* appendActivity(3, "thread-background", "task.started", "2026-07-30T20:02:00.000Z", {
          taskId: "bash-job",
          taskType: "local_bash",
          toolUseId: "tool-bash",
          title: "Compile package",
        });
        // Provider terminal notifications intentionally omit taskType.
        yield* appendActivity(4, "thread-claude", "task.completed", "2026-07-30T20:03:00.000Z", {
          taskId: "claude-agent",
          toolUseId: "tool-claude",
          status: "completed",
          historySessionId: "0123456789abcdef0123456789abcdef",
          title: "Claude finished",
        });
        yield* appendActivity(5, "thread-codex", "task.completed", "2026-07-30T20:04:00.000Z", {
          taskId: "codex-cli:tool-codex",
          toolUseId: "tool-codex",
          status: "failed",
          historySessionId: "fedcba9876543210fedcba9876543210",
        });
        // A late non-terminal duplicate cannot regress a terminal status, but
        // it still advances updatedAt like the live repository upsert.
        yield* appendActivity(6, "thread-claude", "task.progress", "2026-07-30T20:05:00.000Z", {
          taskId: "claude-agent",
          toolUseId: "tool-claude",
          detail: "Late duplicate",
        });
        yield* sql`
          INSERT INTO orchestration_events (
            sequence,
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            actor_kind,
            command_id,
            causation_event_id,
            correlation_id,
            payload_json,
            metadata_json
          )
          VALUES (
            7,
            'event-tip',
            'thread',
            'thread-claude',
            7,
            'thread.goal-set-requested',
            '2026-07-30T20:06:00.000Z',
            'client',
            NULL,
            NULL,
            NULL,
            '{}',
            '{}'
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 41 });

        const readRows = () =>
          sql<AgentRunRow>`
            SELECT
              parent_thread_id AS "parentThreadId",
              provider,
              agent_run_id AS "agentRunId",
              launch_tool_use_id AS "launchToolUseId",
              task_type AS "taskType",
              agent_type AS "agentType",
              model,
              description,
              status,
              started_at AS "startedAt",
              updated_at AS "updatedAt",
              history_session_id AS "historySessionId",
              transcript_state AS "transcriptState",
              parent_native_session_id AS "parentNativeSessionId"
            FROM projection_agent_runs
            ORDER BY parent_thread_id, provider, agent_run_id
          `;
        const rows = yield* readRows();

        assert.deepStrictEqual(rows, [
          {
            parentThreadId: "thread-claude",
            provider: "claude",
            agentRunId: "claude-agent",
            launchToolUseId: "tool-claude",
            taskType: "local_agent",
            agentType: "Explore",
            model: "opus",
            description: "Late duplicate",
            status: "completed",
            startedAt: "2026-07-30T20:00:00.000Z",
            updatedAt: "2026-07-30T20:05:00.000Z",
            historySessionId: "0123456789abcdef0123456789abcdef",
            transcriptState: "linked",
            parentNativeSessionId: "native-parent",
          },
          {
            parentThreadId: "thread-codex",
            provider: "codex",
            agentRunId: "codex-cli:tool-codex",
            launchToolUseId: "tool-codex",
            taskType: "codex_cli",
            agentType: "Codex CLI",
            model: "gpt-5.6-sol",
            description: "Verify the build",
            status: "failed",
            startedAt: "2026-07-30T20:01:00.000Z",
            updatedAt: "2026-07-30T20:04:00.000Z",
            historySessionId: "fedcba9876543210fedcba9876543210",
            transcriptState: "linked",
            parentNativeSessionId: null,
          },
        ]);

        const checkpoint = yield* sql<{
          readonly lastAppliedSequence: number;
          readonly updatedAt: string;
        }>`
          SELECT
            last_applied_sequence AS "lastAppliedSequence",
            updated_at AS "updatedAt"
          FROM projection_state
          WHERE projector = 'projection.agent-runs'
        `;
        assert.deepStrictEqual(checkpoint, [
          {
            lastAppliedSequence: 7,
            updatedAt: "2026-07-30T20:06:00.000Z",
          },
        ]);

        // The fold itself is deterministic if a partially applied database is
        // recovered and the migration body is retried.
        yield* Migration041;
        assert.deepStrictEqual(yield* readRows(), rows);
      }),
  );
});
