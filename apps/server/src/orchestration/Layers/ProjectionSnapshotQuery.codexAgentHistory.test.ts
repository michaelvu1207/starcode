// @effect-diagnostics nodeBuiltinImport:off - writes an isolated Codex rollout fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@starcode/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeHistoryIndex } from "../../history/HistoryIndex.ts";
import { historySessionIdForPath } from "../../history/paths.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  AgentTranscriptReconciliation,
  OrchestrationProjectionSnapshotQueryLive,
} from "./ProjectionSnapshotQuery.ts";

const THREAD_ID = ThreadId.make("thread-real-codex-shape");
const PROJECT_CWD = "/Users/example/Documents/Programming/simcloud-platform";
const TOOL_USE_ID = "toolu_01HHSQs8kcGKWkvg1vf39cjj";
const AGENT_RUN_ID = `codex-cli:${TOOL_USE_ID}`;
const STARTED_AT = "2026-07-31T01:45:21.061Z";
const PROMPT =
  "You are a bounded CI-forensics subagent. Deliverable: /tmp/agent-ci-forensics/REPORT.md.";
const SESSION_ID = "019fb5d8-f12c-7f83-a13c-5d268b413024";
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

it.effect(
  "ProjectionSnapshotQuery links the real legacy itemId + cd + nohup Codex launch shape",
  () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-snapshot-codex-link-")),
      );
      const codexHome = NodePath.join(home, ".codex");
      const rolloutDirectory = NodePath.join(codexHome, "sessions", "2026", "07", "30");
      yield* Effect.promise(() => NodeFSP.mkdir(rolloutDirectory, { recursive: true }));
      const rolloutPath = NodePath.join(
        rolloutDirectory,
        `rollout-2026-07-30T18-45-21-${SESSION_ID}.jsonl`,
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          rolloutPath,
          [
            {
              timestamp: STARTED_AT,
              type: "session_meta",
              payload: {
                id: SESSION_ID,
                cwd: PROJECT_CWD,
                originator: "codex_exec",
                source: "exec",
                thread_source: "user",
              },
            },
            {
              timestamp: "2026-07-31T01:45:21.500Z",
              type: "event_msg",
              payload: { type: "user_message", message: PROMPT },
            },
            {
              timestamp: "2026-07-31T01:48:34.767Z",
              type: "event_msg",
              payload: { type: "task_complete" },
            },
          ]
            .map((record) => encodeUnknownJson(record))
            .join("\n") + "\n",
        ),
      );

      const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provideMerge(
          Layer.succeed(AgentTranscriptReconciliation, {
            agentTranscriptHistoryIndex: makeHistoryIndex({
              homeDir: home,
              codexHome,
              debounceMs: 0,
            }),
            codexHome,
          }),
        ),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'project-real-codex-shape',
            'Real Codex shape',
            ${PROJECT_CWD},
            '{"provider":"codex","model":"gpt-5.6-sol"}',
            '[]',
            '2026-07-31T01:40:00.000Z',
            '2026-07-31T01:40:00.000Z',
            NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            latest_turn_id,
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            ${THREAD_ID},
            'project-real-codex-shape',
            'Consolidating the road-network representations',
            '{"provider":"codex","model":"gpt-5.6-sol"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-07-31T01:40:00.000Z',
            '2026-07-31T01:54:50.077Z',
            NULL
          )
        `;
        yield* sql`
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
            ${THREAD_ID},
            'codex',
            ${AGENT_RUN_ID},
            ${TOOL_USE_ID},
            'codex_cli',
            'Codex CLI',
            'gpt-5.6-sol',
            ${PROMPT},
            'completed',
            ${STARTED_AT},
            '2026-07-31T01:48:34.767Z',
            '4a96de8454be69fc8f4d1c1b3e8b990b',
            'linked',
            NULL
          )
        `;

        const command =
          `mkdir -p /tmp/agent-ci-forensics\ncd ${PROJECT_CWD} && ` +
          `nohup codex exec -C . --enable multi_agent -m gpt-5.6-sol ` +
          `"${PROMPT}" > /tmp/codex-ci-forensics.log 2>&1 &`;
        const toolPayload = encodeUnknownJson({
          itemType: "command_execution",
          itemId: TOOL_USE_ID,
          parentToolUseId: TOOL_USE_ID,
          status: "inProgress",
          detail: "Bash: mkdir -p /tmp/agent-ci-forensics ...",
          data: {
            toolName: "Bash",
            input: {
              command,
              description: "Dispatch the CI forensics subagent",
              run_in_background: true,
            },
          },
        });
        const taskPayload = encodeUnknownJson({
          taskId: AGENT_RUN_ID,
          taskType: "codex_cli",
          detail: PROMPT,
          subagentType: "Codex CLI",
          toolUseId: TOOL_USE_ID,
          model: "gpt-5.6-sol",
        });
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'activity-real-tool-updated',
              ${THREAD_ID},
              NULL,
              'tool',
              'tool.updated',
              'Dispatch the CI forensics subagent',
              ${toolPayload},
              NULL,
              ${STARTED_AT}
            ),
            (
              'activity-real-task-started',
              ${THREAD_ID},
              NULL,
              'info',
              'task.started',
              'Codex CLI task started',
              ${taskPayload},
              NULL,
              ${STARTED_AT}
            )
        `;

        const detail = yield* query.getThreadDetailById(THREAD_ID);
        assert.equal(detail._tag, "Some");
        if (detail._tag !== "Some") return;
        const expectedHistorySessionId = historySessionIdForPath(rolloutPath);
        assert.deepStrictEqual(detail.value.agentRuns, [
          {
            parentThreadId: THREAD_ID,
            provider: "codex",
            agentRunId: AGENT_RUN_ID,
            launchToolUseId: TOOL_USE_ID,
            taskType: "codex_cli",
            agentType: "Codex CLI",
            model: "gpt-5.6-sol",
            description: PROMPT,
            status: "completed",
            startedAt: STARTED_AT,
            updatedAt: "2026-07-31T01:48:34.767Z",
            historySessionId: expectedHistorySessionId,
            transcriptState: "linked",
          },
        ]);

        const persisted = yield* sql<{
          readonly historySessionId: string | null;
          readonly transcriptState: string;
        }>`
          SELECT
            history_session_id AS "historySessionId",
            transcript_state AS "transcriptState"
          FROM projection_agent_runs
          WHERE parent_thread_id = ${THREAD_ID}
            AND provider = 'codex'
            AND agent_run_id = ${AGENT_RUN_ID}
        `;
        assert.deepStrictEqual(persisted, [
          {
            historySessionId: expectedHistorySessionId,
            transcriptState: "linked",
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
);
