import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionAgentRun,
  ProjectionAgentRunRepository,
  type ProjectionAgentRunRepositoryShape,
} from "../Services/ProjectionAgentRuns.ts";

const makeProjectionAgentRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionAgentRun,
    execute: (row) =>
      sql`
        INSERT INTO projection_agent_runs (
          parent_thread_id,
          provider,
          agent_run_id,
          launch_tool_use_id,
          task_type,
          agent_type,
          model,
          description,
          status,
          started_at,
          updated_at,
          history_session_id,
          transcript_state,
          parent_native_session_id
        )
        VALUES (
          ${row.parentThreadId},
          ${row.provider},
          ${row.agentRunId},
          ${row.launchToolUseId},
          ${row.taskType},
          ${row.agentType},
          ${row.model},
          ${row.description},
          ${row.status},
          ${row.startedAt},
          ${row.updatedAt},
          ${row.historySessionId},
          ${row.transcriptState},
          ${row.parentNativeSessionId}
        )
        ON CONFLICT (parent_thread_id, provider, agent_run_id)
        DO UPDATE SET
          launch_tool_use_id =
            COALESCE(excluded.launch_tool_use_id, projection_agent_runs.launch_tool_use_id),
          task_type = COALESCE(excluded.task_type, projection_agent_runs.task_type),
          agent_type = COALESCE(excluded.agent_type, projection_agent_runs.agent_type),
          model = COALESCE(excluded.model, projection_agent_runs.model),
          description = COALESCE(excluded.description, projection_agent_runs.description),
          status = CASE
            WHEN projection_agent_runs.status IN ('completed', 'failed', 'stopped')
              THEN projection_agent_runs.status
            WHEN excluded.updated_at < projection_agent_runs.updated_at
              THEN projection_agent_runs.status
            ELSE excluded.status
          END,
          started_at = MIN(projection_agent_runs.started_at, excluded.started_at),
          updated_at = MAX(projection_agent_runs.updated_at, excluded.updated_at),
          history_session_id =
            COALESCE(excluded.history_session_id, projection_agent_runs.history_session_id),
          transcript_state = CASE
            WHEN excluded.history_session_id IS NOT NULL THEN 'linked'
            ELSE projection_agent_runs.transcript_state
          END,
          parent_native_session_id = COALESCE(
            excluded.parent_native_session_id,
            projection_agent_runs.parent_native_session_id
          )
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({ parentThreadId: ProjectionAgentRun.fields.parentThreadId }),
    Result: ProjectionAgentRun,
    execute: ({ parentThreadId }) =>
      sql`
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
        WHERE parent_thread_id = ${parentThreadId}
        ORDER BY
          CASE WHEN status IN ('running', 'paused') THEN 0 ELSE 1 END,
          CASE WHEN status IN ('running', 'paused') THEN started_at END ASC,
          CASE WHEN status NOT IN ('running', 'paused') THEN updated_at END DESC,
          provider,
          agent_run_id
      `,
  });

  const replaceHistoryLinkRow = SqlSchema.void({
    Request: Schema.Struct({
      parentThreadId: ProjectionAgentRun.fields.parentThreadId,
      provider: ProjectionAgentRun.fields.provider,
      agentRunId: ProjectionAgentRun.fields.agentRunId,
      historySessionId: ProjectionAgentRun.fields.historySessionId,
      transcriptState: ProjectionAgentRun.fields.transcriptState,
    }),
    execute: (input) =>
      sql`
        UPDATE projection_agent_runs
        SET
          history_session_id = ${input.historySessionId},
          transcript_state = ${input.transcriptState}
        WHERE parent_thread_id = ${input.parentThreadId}
          AND provider = ${input.provider}
          AND agent_run_id = ${input.agentRunId}
      `,
  });

  const deleteRows = SqlSchema.void({
    Request: Schema.Struct({ parentThreadId: ProjectionAgentRun.fields.parentThreadId }),
    execute: ({ parentThreadId }) =>
      sql`
        DELETE FROM projection_agent_runs
        WHERE parent_thread_id = ${parentThreadId}
      `,
  });

  const upsert: ProjectionAgentRunRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAgentRunRepository.upsert:query")),
    );
  const listByParentThreadId: ProjectionAgentRunRepositoryShape["listByParentThreadId"] = (
    parentThreadId,
  ) =>
    listRows({ parentThreadId }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAgentRunRepository.list:query")),
    );
  const replaceHistoryLink: ProjectionAgentRunRepositoryShape["replaceHistoryLink"] = (input) =>
    replaceHistoryLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionAgentRunRepository.replaceHistoryLink:query"),
      ),
    );
  const deleteByParentThreadId: ProjectionAgentRunRepositoryShape["deleteByParentThreadId"] = (
    parentThreadId,
  ) =>
    deleteRows({ parentThreadId }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAgentRunRepository.delete:query")),
    );

  return {
    upsert,
    listByParentThreadId,
    replaceHistoryLink,
    deleteByParentThreadId,
  } satisfies ProjectionAgentRunRepositoryShape;
});

export const ProjectionAgentRunRepositoryLive = Layer.effect(
  ProjectionAgentRunRepository,
  makeProjectionAgentRunRepository,
);
