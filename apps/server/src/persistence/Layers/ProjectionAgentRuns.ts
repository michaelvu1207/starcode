import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "@starcode/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionAgentRun,
  ProjectionAgentRunRepository,
  type ProjectionAgentRunRepositoryShape,
} from "../Services/ProjectionAgentRuns.ts";

const ProjectionAgentRunDbRow = ProjectionAgentRun.mapFields(
  Struct.assign({
    options: Schema.fromJsonString(ProviderOptionSelections),
  }),
);

const makeProjectionAgentRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionAgentRun,
    execute: (row) =>
      sql`
        INSERT INTO projection_agent_runs (
          parent_thread_id,
          provider,
          provider_instance_id,
          agent_run_id,
          parent_agent_run_id,
          launch_tool_use_id,
          task_type,
          agent_type,
          model,
          model_options_json,
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
          ${row.providerInstanceId ?? null},
          ${row.agentRunId},
          ${row.parentAgentRunId ?? null},
          ${row.launchToolUseId},
          ${row.taskType},
          ${row.agentType},
          ${row.model},
          ${JSON.stringify(row.options ?? [])},
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
          provider_instance_id = COALESCE(
            excluded.provider_instance_id,
            projection_agent_runs.provider_instance_id
          ),
          parent_agent_run_id = COALESCE(
            excluded.parent_agent_run_id,
            projection_agent_runs.parent_agent_run_id
          ),
          launch_tool_use_id =
            COALESCE(excluded.launch_tool_use_id, projection_agent_runs.launch_tool_use_id),
          task_type = COALESCE(excluded.task_type, projection_agent_runs.task_type),
          agent_type = COALESCE(excluded.agent_type, projection_agent_runs.agent_type),
          model = COALESCE(excluded.model, projection_agent_runs.model),
          model_options_json = CASE
            WHEN excluded.model_options_json = '[]' THEN projection_agent_runs.model_options_json
            ELSE excluded.model_options_json
          END,
          -- The first non-empty description is the stable spawn identity. A
          -- concurrently projected progress event (for example token usage)
          -- must not rename the row after the fact.
          description = COALESCE(projection_agent_runs.description, excluded.description),
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
    Result: ProjectionAgentRunDbRow,
    execute: ({ parentThreadId }) =>
      sql`
        SELECT
          parent_thread_id AS "parentThreadId",
          provider,
          provider_instance_id AS "providerInstanceId",
          agent_run_id AS "agentRunId",
          parent_agent_run_id AS "parentAgentRunId",
          launch_tool_use_id AS "launchToolUseId",
          task_type AS "taskType",
          agent_type AS "agentType",
          model,
          COALESCE(model_options_json, '[]') AS options,
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

  const listNonterminalAttachedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionAgentRunDbRow,
    execute: () => sql`
      SELECT
        parent_thread_id AS "parentThreadId",
        provider,
        provider_instance_id AS "providerInstanceId",
        agent_run_id AS "agentRunId",
        parent_agent_run_id AS "parentAgentRunId",
        launch_tool_use_id AS "launchToolUseId",
        task_type AS "taskType",
        agent_type AS "agentType",
        model,
        COALESCE(model_options_json, '[]') AS options,
        description,
        status,
        started_at AS "startedAt",
        updated_at AS "updatedAt",
        history_session_id AS "historySessionId",
        transcript_state AS "transcriptState",
        parent_native_session_id AS "parentNativeSessionId"
      FROM projection_agent_runs
      WHERE task_type = 'attached_agent'
        AND status IN ('running', 'paused')
      ORDER BY started_at ASC, parent_thread_id ASC, agent_run_id ASC
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
  const listNonterminalAttached: ProjectionAgentRunRepositoryShape["listNonterminalAttached"] =
    () =>
      listNonterminalAttachedRows().pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionAgentRunRepository.listNonterminalAttached:query"),
        ),
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
    listNonterminalAttached,
    replaceHistoryLink,
    deleteByParentThreadId,
  } satisfies ProjectionAgentRunRepositoryShape;
});

export const ProjectionAgentRunRepositoryLive = Layer.effect(
  ProjectionAgentRunRepository,
  makeProjectionAgentRunRepository,
);
