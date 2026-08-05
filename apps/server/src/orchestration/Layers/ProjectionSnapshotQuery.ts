// @effect-diagnostics nodeBuiltinImport:off - exact Codex rollout ownership
// resolves the parent task's persisted working directory.
import * as NodePath from "node:path";

import {
  ChatAttachment,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  ProjectScript,
  ProviderOptionSelections,
  TurnId,
  type OrchestrationCheckpointSummary,
  type AgentRun,
  type HistorySessionId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadPlanSummary,
  type OrchestrationThreadShell,
  ModelSelection,
  ProjectId,
  ThreadId,
  ThreadGoal,
} from "@starcode/contracts";
import { detectCodexCliSubagent } from "@starcode/shared/codexCliSubagent";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import {
  makeHistoryIndex,
  type HistoryIndexEntry,
  type HistoryIndexShape,
} from "../../history/HistoryIndex.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionAgentRun } from "../../persistence/Services/ProjectionAgentRuns.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  discoverCodexCliRollout,
  probeCodexCliRolloutLiveness,
  readCodexCliRolloutTerminal,
  resolveCodexCliInvocationPrompt,
} from "../../provider/Layers/CodexCliRolloutDiscovery.ts";
import { derivePlanSummary } from "../threadPlanSummary.ts";
import { deriveLiveSubagents, type SubagentActivityRow } from "../threadSubagentSummary.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    goal: Schema.NullOr(Schema.fromJsonString(ThreadGoal)),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionAgentRunDbRowSchema = ProjectionAgentRun.mapFields(
  Struct.assign({ options: Schema.fromJsonString(ProviderOptionSelections) }),
);
const ProjectionThreadNativeSessionDbRowSchema = Schema.Struct({
  nativeSessionId: Schema.String,
});
// Only the columns the row-level plan rollup needs. Plans are read from the
// activity timeline rather than denormalized onto projection_threads, so the
// summary needs no migration and can never drift from the activities the
// thread view renders.
const ProjectionThreadPlanActivityDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  payload: Schema.fromJsonString(Schema.Unknown),
});
const ProjectionThreadSubagentActivityDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  kind: Schema.String,
  createdAt: Schema.String,
  payload: Schema.fromJsonString(Schema.Unknown),
});
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.agentRuns,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    ...(row.providerThreadId !== null ? { providerThreadId: row.providerThreadId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function mapAgentRunRow(row: Schema.Schema.Type<typeof ProjectionAgentRunDbRowSchema>): AgentRun {
  return {
    parentThreadId: row.parentThreadId,
    provider: row.provider,
    providerInstanceId: row.providerInstanceId,
    agentRunId: row.agentRunId,
    parentAgentRunId: row.parentAgentRunId,
    launchToolUseId: row.launchToolUseId,
    taskType: row.taskType,
    agentType: row.agentType,
    model: row.model,
    options: row.options,
    description: row.description,
    status: row.status,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    historySessionId: row.historySessionId,
    transcriptState: row.transcriptState,
  };
}

function activityPayload(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function activityString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function providerItemId(payload: Record<string, unknown> | null): string | null {
  return activityString(payload?.providerItemId) ?? activityString(payload?.itemId);
}

function isValidPersistedHistoryEntry(
  row: Schema.Schema.Type<typeof ProjectionAgentRunDbRowSchema>,
  entry: HistoryIndexEntry | null,
): boolean {
  if (entry === null || entry.provider !== row.provider) return false;
  if (row.provider === "claude") {
    return (
      entry.kind === "subagent" &&
      entry.agentRunId === row.agentRunId &&
      entry.claudeSubagentMetadata?.toolUseId === row.launchToolUseId
    );
  }
  return entry.kind === "session";
}

function hasAgentRunOwnershipProof(
  row: Schema.Schema.Type<typeof ProjectionAgentRunDbRowSchema>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  if (row.launchToolUseId === null) return false;
  return activities.some((activity) => {
    if (!activity.kind.startsWith("task.")) return false;
    const payload = activityPayload(activity.payload);
    return (
      activityString(payload?.taskId) === row.agentRunId &&
      activityString(payload?.toolUseId) === row.launchToolUseId
    );
  });
}

function findCodexLaunchInvocation(
  launchToolUseId: string,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  for (const activity of activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const payload = activityPayload(activity.payload);
    const data = activityPayload(payload?.data);
    const itemId =
      providerItemId(payload) ??
      activityString(payload?.toolUseId) ??
      activityString(data?.toolUseId);
    if (itemId !== launchToolUseId) continue;
    const toolName = activityString(data?.toolName);
    const toolInput = activityPayload(data?.input);
    if (toolName === null || toolInput === null) continue;
    const invocation = detectCodexCliSubagent(toolName, toolInput);
    if (invocation !== null) return { activity, invocation };
  }
  return null;
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

// Shell fields are omitted, not nulled, when absent: a thread with no task
// list must produce the same payload a server without this rollup would send.
function maybePlanSummary(payload: unknown): { planSummary?: OrchestrationThreadPlanSummary } {
  const summary = derivePlanSummary(payload);
  return summary === null ? {} : { planSummary: summary };
}

function isFullyStoppedSession(session: OrchestrationSession | null | undefined): boolean {
  return session?.status === "stopped" && session.activeTurnId === null;
}

interface ProjectionSnapshotQueryOptions {
  readonly agentTranscriptHistoryIndex: HistoryIndexShape;
  readonly codexHome?: string;
}

export const AgentTranscriptReconciliation = Context.Reference<ProjectionSnapshotQueryOptions>(
  "starcode/orchestration/AgentTranscriptReconciliation",
  {
    // Resolve provider-home settings when the server runtime layer is built,
    // not when this module is first imported. Isolated desktop runtimes can
    // establish HOME/CODEX_HOME during bootstrap.
    defaultValue: () => ({
      agentTranscriptHistoryIndex: makeHistoryIndex({ debounceMs: 0 }),
      ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
    }),
  },
);

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const { agentTranscriptHistoryIndex, codexHome } = yield* AgentTranscriptReconciliation;
  const repositoryIdentityResolutionConcurrency = 4;
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          side_of_thread_id AS "sideOfThreadId",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          goal_json AS "goal"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          side_of_thread_id AS "sideOfThreadId",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          goal_json AS "goal"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  });

  // Newest plan activity per thread, in one pass. Ordering mirrors the
  // ascending convention in ProjectionThreadActivityRepository.listByThreadId
  // (runtime sequence when present, creation order otherwise), reversed.
  const listLatestPlanActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadPlanActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          payload_json AS "payload"
        FROM (
          SELECT
            thread_id,
            payload_json,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS plan_rank
          FROM projection_thread_activities
          WHERE kind = 'turn.plan.updated'
        )
        WHERE plan_rank = 1
      `,
  });

  const listArchivedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          side_of_thread_id AS "sideOfThreadId",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          goal_json AS "goal"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const agentRunSelect = sql`
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
  `;

  const listAgentRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionAgentRunDbRowSchema,
    execute: () =>
      sql`${agentRunSelect}
        ORDER BY parent_thread_id, updated_at DESC, provider, agent_run_id`,
  });

  const listAgentRunRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionAgentRunDbRowSchema,
    execute: ({ threadId }) =>
      sql`${agentRunSelect}
        WHERE parent_thread_id = ${threadId}
        ORDER BY
          CASE WHEN status IN ('running', 'paused') THEN 0 ELSE 1 END,
          CASE WHEN status IN ('running', 'paused') THEN started_at END ASC,
          CASE WHEN status NOT IN ('running', 'paused') THEN updated_at END DESC,
          provider,
          agent_run_id`,
  });

  const listClaudeNativeSessionRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadNativeSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT native_session_id AS "nativeSessionId"
        FROM projection_thread_native_sessions
        WHERE thread_id = ${threadId}
          AND provider = 'claude'
        ORDER BY observed_at ASC, native_session_id ASC
      `,
  });

  const persistAgentRunHistory = (input: {
    readonly parentThreadId: ThreadId;
    readonly provider: ProjectionAgentRun["provider"];
    readonly agentRunId: string;
    readonly historySessionId: HistorySessionId | null;
    readonly transcriptState: "linked" | "pending" | "unavailable";
    readonly status: ProjectionAgentRun["status"] | null;
  }) =>
    sql`
      UPDATE projection_agent_runs
      SET
        history_session_id = ${input.historySessionId},
        transcript_state = ${input.transcriptState},
        status = COALESCE(${input.status}, status)
      WHERE parent_thread_id = ${input.parentThreadId}
        AND provider = ${input.provider}
        AND agent_run_id = ${input.agentRunId}
    `;

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN 'stopped'
            ELSE sessions.status
          END AS status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN NULL
            ELSE sessions.active_turn_id
          END AS "activeTurnId",
          sessions.last_error AS "lastError",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN runtime.last_seen_at
            ELSE sessions.updated_at
          END AS "updatedAt"
        FROM projection_thread_sessions sessions
        LEFT JOIN provider_session_runtime runtime
          ON runtime.thread_id = sessions.thread_id
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN 'stopped'
            ELSE sessions.status
          END AS status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN NULL
            ELSE sessions.active_turn_id
          END AS "activeTurnId",
          sessions.last_error AS "lastError",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN runtime.last_seen_at
            ELSE sessions.updated_at
          END AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        LEFT JOIN provider_session_runtime runtime
          ON runtime.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listArchivedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN 'stopped'
            ELSE sessions.status
          END AS status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN NULL
            ELSE sessions.active_turn_id
          END AS "activeTurnId",
          sessions.last_error AS "lastError",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN runtime.last_seen_at
            ELSE sessions.updated_at
          END AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        LEFT JOIN provider_session_runtime runtime
          ON runtime.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listArchivedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          side_of_thread_id AS "sideOfThreadId",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          goal_json AS "goal"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  /**
   * The first and last `task.*` activity for every subagent, across threads.
   *
   * Two rows per task, never more. A running subagent emits a `task.progress`
   * every ~30s, so selecting every task row would make this query grow without
   * bound in the length of a session — and the fold needs only two points: the
   * opening `task.started`, which is where `toolUseId` and `subagentType` are
   * reported, and the newest row, which is where the current status,
   * `lastToolName` and token total live. Everything in between is superseded.
   *
   * `taskId` lives inside the payload rather than in a column, so it is read
   * with `json_extract`; rows without one cannot be attributed and are dropped
   * here instead of being carried to the fold.
   */
  const listSubagentActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSubagentActivityDbRowSchema,
    execute: () =>
      sql`
        WITH task_rows AS (
          SELECT
            thread_id,
            json_extract(payload_json, '$.taskId') AS task_id,
            kind,
            created_at,
            activity_id,
            sequence,
            payload_json
          FROM projection_thread_activities
          WHERE kind LIKE 'task.%'
            AND json_extract(payload_json, '$.taskId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM projection_agent_runs AS agent_runs
              WHERE agent_runs.parent_thread_id = projection_thread_activities.thread_id
                AND agent_runs.agent_run_id = json_extract(payload_json, '$.taskId')
                AND agent_runs.status IN ('completed', 'failed', 'stopped')
            )
        ),
        ranked AS (
          SELECT
            thread_id,
            task_id,
            kind,
            created_at,
            activity_id,
            sequence,
            payload_json,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id, task_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                CASE
                  WHEN kind = 'task.completed' THEN 2
                  WHEN kind = 'task.updated'
                    AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'killed')
                    THEN 2
                  ELSE 1
                END DESC,
                activity_id DESC
            ) AS newest_rank,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id, task_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
                sequence ASC,
                created_at ASC,
                CASE
                  WHEN kind = 'task.completed' THEN 2
                  WHEN kind = 'task.updated'
                    AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'killed')
                    THEN 2
                  ELSE 1
                END ASC,
                activity_id ASC
            ) AS oldest_rank
          FROM task_rows
        )
        SELECT
          thread_id AS "threadId",
          kind,
          created_at AS "createdAt",
          payload_json AS "payload"
        FROM ranked
        WHERE newest_rank = 1 OR oldest_rank = 1
        ORDER BY
          thread_id ASC,
          task_id ASC,
          CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
          sequence ASC,
          created_at ASC,
          CASE
            WHEN kind = 'task.completed' THEN 2
            WHEN kind = 'task.updated'
              AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'killed')
              THEN 2
            ELSE 1
          END ASC,
          activity_id ASC
      `,
  });

  /** Single-thread counterpart of listSubagentActivityRows. */
  const listSubagentActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSubagentActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH task_rows AS (
          SELECT
            thread_id,
            json_extract(payload_json, '$.taskId') AS task_id,
            kind,
            created_at,
            activity_id,
            sequence,
            payload_json
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind LIKE 'task.%'
            AND json_extract(payload_json, '$.taskId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM projection_agent_runs AS agent_runs
              WHERE agent_runs.parent_thread_id = projection_thread_activities.thread_id
                AND agent_runs.agent_run_id = json_extract(payload_json, '$.taskId')
                AND agent_runs.status IN ('completed', 'failed', 'stopped')
            )
        ),
        ranked AS (
          SELECT
            thread_id,
            task_id,
            kind,
            created_at,
            activity_id,
            sequence,
            payload_json,
            ROW_NUMBER() OVER (
              PARTITION BY task_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                CASE
                  WHEN kind = 'task.completed' THEN 2
                  WHEN kind = 'task.updated'
                    AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'killed')
                    THEN 2
                  ELSE 1
                END DESC,
                activity_id DESC
            ) AS newest_rank,
            ROW_NUMBER() OVER (
              PARTITION BY task_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
                sequence ASC,
                created_at ASC,
                CASE
                  WHEN kind = 'task.completed' THEN 2
                  WHEN kind = 'task.updated'
                    AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'killed')
                    THEN 2
                  ELSE 1
                END ASC,
                activity_id ASC
            ) AS oldest_rank
          FROM task_rows
        )
        SELECT
          thread_id AS "threadId",
          kind,
          created_at AS "createdAt",
          payload_json AS "payload"
        FROM ranked
        WHERE newest_rank = 1 OR oldest_rank = 1
        ORDER BY
          task_id ASC,
          CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
          sequence ASC,
          created_at ASC,
          CASE
            WHEN kind = 'task.completed' THEN 2
            WHEN kind = 'task.updated'
              AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'killed')
              THEN 2
            ELSE 1
          END ASC,
          activity_id ASC
      `,
  });

  // Single-thread counterpart of listLatestPlanActivityRows, used by the shell
  // stream's per-thread refetch. Walks the (thread_id, sequence, created_at,
  // activity_id) index backwards and stops at the first plan row.
  const getLatestPlanActivityRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadPlanActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          payload_json AS "payload"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind = 'turn.plan.updated'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT 1
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN 'stopped'
            ELSE sessions.status
          END AS status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN NULL
            ELSE sessions.active_turn_id
          END AS "activeTurnId",
          sessions.last_error AS "lastError",
          CASE
            WHEN runtime.status = 'stopped'
              AND runtime.last_seen_at >= sessions.updated_at
              THEN runtime.last_seen_at
            ELSE sessions.updated_at
          END AS "updatedAt"
        FROM projection_thread_sessions sessions
        LEFT JOIN provider_session_runtime runtime
          ON runtime.thread_id = sessions.thread_id
        WHERE sessions.thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          threads.side_of_thread_id AS "sideOfThreadId",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listAgentRunRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listAgentRuns:query",
                "ProjectionSnapshotQuery.getSnapshot:listAgentRuns:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            agentRunRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const agentRunsByThread = new Map<string, Array<AgentRun>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of agentRunRows) {
                const runs = agentRunsByThread.get(row.parentThreadId) ?? [];
                runs.push(mapAgentRunRow(row));
                agentRunsByThread.set(row.parentThreadId, runs);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  ...(row.providerThreadId !== null
                    ? { providerThreadId: row.providerThreadId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );
              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                branch: row.branch,
                worktreePath: row.worktreePath,
                sideOfThreadId: row.sideOfThreadId,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                agentRuns: agentRunsByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
                goal: row.goal,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listAgentRunRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listAgentRuns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listAgentRuns:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            proposedPlanRows,
            agentRunRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.sync(() => {
              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const threads: OrchestrationThread[] = [];

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  defaultModelSelection: row.defaultModelSelection,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const agentRunsByThread = new Map<string, Array<AgentRun>>();
              const sessionByThread = new Map<string, OrchestrationSession>();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(row.threadId, mapSessionRow(row));
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (let index = 0; index < agentRunRows.length; index += 1) {
                const row = agentRunRows[index];
                if (!row) {
                  continue;
                }
                const runs = agentRunsByThread.get(row.parentThreadId) ?? [];
                runs.push(mapAgentRunRow(row));
                agentRunsByThread.set(row.parentThreadId, runs);
              }

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  sideOfThreadId: row.sideOfThreadId,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  deletedAt: row.deletedAt,
                  messages: [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  activities: [],
                  agentRuns: agentRunsByThread.get(row.threadId) ?? [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                  goal: row.goal,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(([projectRows, threadRows, sessionRows, latestTurnRows, stateRows]) =>
          Effect.gen(function* () {
            let updatedAt: string | null = null;
            for (const row of projectRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of threadRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of sessionRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of latestTurnRows) {
              updatedAt = maxIso(updatedAt, row.requestedAt);
              if (row.startedAt !== null) {
                updatedAt = maxIso(updatedAt, row.startedAt);
              }
              if (row.completedAt !== null) {
                updatedAt = maxIso(updatedAt, row.completedAt);
              }
            }
            for (const row of stateRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }

            const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(projectRows);
            const latestTurnByThread = new Map(
              latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
            );
            const sessionByThread = new Map<string, OrchestrationSession>(
              sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
            );

            // Read after the snapshot transaction rather than inside it: the
            // rollup is derived and read-only, so a plan appended in between
            // only makes the bar fresher than the rest of the snapshot.
            const planRows = yield* listLatestPlanActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getShellSnapshot:listLatestPlanActivities:query",
                  "ProjectionSnapshotQuery.getShellSnapshot:listLatestPlanActivities:decodeRows",
                ),
              ),
            );
            const planSummaryByThread = new Map(
              Arr.filterMap(planRows, (row) => {
                const summary = derivePlanSummary(row.payload);
                return summary === null
                  ? Result.failVoid
                  : Result.succeed([row.threadId, summary] as const);
              }),
            );

            // Same read-after-the-transaction reasoning as the plan rollup: the
            // list is derived and read-only, so an agent that started in
            // between only makes the sidebar fresher than the rest of the
            // snapshot.
            const subagentRows = yield* listSubagentActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getShellSnapshot:listSubagentActivities:query",
                  "ProjectionSnapshotQuery.getShellSnapshot:listSubagentActivities:decodeRows",
                ),
              ),
            );
            const subagentRowsByThread = new Map<string, Array<SubagentActivityRow>>();
            for (const row of subagentRows) {
              const bucket = subagentRowsByThread.get(row.threadId);
              if (bucket) {
                bucket.push(row);
              } else {
                subagentRowsByThread.set(row.threadId, [row]);
              }
            }
            const subagentsByThread = new Map(
              Arr.filterMap([...subagentRowsByThread], ([threadId, rows]) => {
                if (isFullyStoppedSession(sessionByThread.get(threadId))) {
                  return Result.failVoid;
                }
                const live = deriveLiveSubagents(rows);
                return live.length === 0
                  ? Result.failVoid
                  : Result.succeed([threadId, live] as const);
              }),
            );

            const snapshot = {
              snapshotSequence: computeSnapshotSequence(stateRows),
              projects: Arr.filterMap(projectRows, (row) =>
                row.deletedAt === null
                  ? Result.succeed(
                      mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                    )
                  : Result.failVoid,
              ),
              threads: Arr.filterMap(threadRows, (row) =>
                row.deletedAt === null
                  ? Result.succeed({
                      id: row.threadId,
                      projectId: row.projectId,
                      title: row.title,
                      modelSelection: row.modelSelection,
                      runtimeMode: row.runtimeMode,
                      interactionMode: row.interactionMode,
                      branch: row.branch,
                      worktreePath: row.worktreePath,
                      sideOfThreadId: row.sideOfThreadId,
                      latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                      createdAt: row.createdAt,
                      updatedAt: row.updatedAt,
                      archivedAt: row.archivedAt,
                      session: sessionByThread.get(row.threadId) ?? null,
                      latestUserMessageAt: row.latestUserMessageAt,
                      hasPendingApprovals: row.pendingApprovalCount > 0,
                      hasPendingUserInput: row.pendingUserInputCount > 0,
                      hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                      // Omitted rather than null when the thread has no task
                      // list, so shells stay byte-identical to what servers
                      // without this rollup send.
                      ...(planSummaryByThread.has(row.threadId)
                        ? { planSummary: planSummaryByThread.get(row.threadId) }
                        : {}),
                      // Omitted, not empty-arrayed, when nothing is running —
                      // same contract as planSummary above.
                      ...(subagentsByThread.has(row.threadId)
                        ? { subagents: subagentsByThread.get(row.threadId) }
                        : {}),
                      ...(row.goal
                        ? {
                            goalSummary: {
                              status: row.goal.status,
                              updatedAt: row.goal.updatedAt,
                            },
                          }
                        : {}),
                    } satisfies OrchestrationThreadShell)
                  : Result.failVoid,
              ),
              updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
            };

            return yield* decodeShellSnapshot(snapshot).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                ),
              ),
            );
          }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(([projectRows, threadRows, sessionRows, latestTurnRows, stateRows]) =>
          Effect.gen(function* () {
            let updatedAt: string | null = null;
            for (const row of projectRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of threadRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of sessionRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of latestTurnRows) {
              updatedAt = maxIso(updatedAt, row.requestedAt);
              if (row.startedAt !== null) {
                updatedAt = maxIso(updatedAt, row.startedAt);
              }
              if (row.completedAt !== null) {
                updatedAt = maxIso(updatedAt, row.completedAt);
              }
            }
            for (const row of stateRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }

            const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
            const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
              projectRows.filter((row) => activeProjectIds.has(row.projectId)),
            );
            const latestTurnByThread = new Map(
              latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
            );
            const sessionByThread = new Map(
              sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
            );

            const snapshot = {
              snapshotSequence: computeSnapshotSequence(stateRows),
              projects: Arr.filterMap(projectRows, (row) =>
                row.deletedAt === null && activeProjectIds.has(row.projectId)
                  ? Result.succeed(
                      mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                    )
                  : Result.failVoid,
              ),
              threads: threadRows.map(
                (row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  sideOfThreadId: row.sideOfThreadId,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                  ...(row.goal
                    ? {
                        goalSummary: {
                          status: row.goal.status,
                          updatedAt: row.goal.updatedAt,
                        },
                      }
                    : {}),
                }),
              ),
              updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
            };

            return yield* decodeShellSnapshot(snapshot).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.getArchivedShellSnapshot:decodeShellSnapshot",
                ),
              ),
            );
          }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape["getFullThreadDiffContext"]
  > = (threadId, toTurnCount) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, latestTurnRow, sessionRow, planRow, subagentRows] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
        getLatestPlanActivityRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestPlanActivity:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestPlanActivity:decodeRow",
            ),
          ),
        ),
        listSubagentActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:listSubagentActivities:query",
              "ProjectionSnapshotQuery.getThreadShellById:listSubagentActivities:decodeRows",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      const session = Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null;
      const liveSubagents = isFullyStoppedSession(session) ? [] : deriveLiveSubagents(subagentRows);

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        sideOfThreadId: threadRow.value.sideOfThreadId,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        session,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        ...(Option.isSome(planRow) ? maybePlanSummary(planRow.value.payload) : {}),
        ...(liveSubagents.length > 0 ? { subagents: liveSubagents } : {}),
        ...(threadRow.value.goal
          ? {
              goalSummary: {
                status: threadRow.value.goal.status,
                updatedAt: threadRow.value.goal.updatedAt,
              },
            }
          : {}),
      } satisfies OrchestrationThreadShell);
    });

  const reconcileAgentRunHistories = Effect.fn(
    "ProjectionSnapshotQuery.reconcileAgentRunHistories",
  )(function* (input: {
    readonly parentCwd: string | null;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
    readonly rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionAgentRunDbRowSchema>>;
    readonly claudeNativeSessionIds: ReadonlySet<string>;
  }) {
    const persistState = (
      row: Schema.Schema.Type<typeof ProjectionAgentRunDbRowSchema>,
      historySessionId: HistorySessionId | null,
      transcriptState: "linked" | "pending" | "unavailable",
      status: ProjectionAgentRun["status"] | null = null,
    ) =>
      persistAgentRunHistory({
        parentThreadId: row.parentThreadId,
        provider: row.provider,
        agentRunId: row.agentRunId,
        historySessionId,
        transcriptState,
        status,
      }).pipe(
        Effect.as({
          ...row,
          historySessionId,
          transcriptState,
          ...(status !== null ? { status } : {}),
        }),
      );

    return yield* Effect.forEach(
      input.rows,
      (row) =>
        Effect.gen(function* () {
          if (row.provider !== "claude" && row.provider !== "codex") {
            return row.transcriptState === "unavailable"
              ? row
              : yield* persistState(row, null, "unavailable").pipe(
                  Effect.orElseSucceed(
                    () =>
                      ({
                        ...row,
                        historySessionId: null,
                        transcriptState: "unavailable",
                      }) satisfies ProjectionAgentRun,
                  ),
                );
          }
          if (row.historySessionId !== null) {
            const entry = yield* agentTranscriptHistoryIndex.resolve(row.historySessionId);
            if (isValidPersistedHistoryEntry(row, entry)) {
              if (row.transcriptState === "linked") return row;
              return yield* persistState(row, row.historySessionId, "linked").pipe(
                Effect.orElseSucceed(
                  () =>
                    ({
                      ...row,
                      transcriptState: "linked",
                    }) satisfies ProjectionAgentRun,
                ),
              );
            }
          }

          const hasOwnershipProof = hasAgentRunOwnershipProof(row, input.activities);
          let discoveredHistorySessionId: HistorySessionId | null = null;
          let discoveredStatus: ProjectionAgentRun["status"] | null = null;

          if (hasOwnershipProof && row.provider === "claude" && row.launchToolUseId !== null) {
            const matches = new Map<string, HistoryIndexEntry>();
            for (const parentNativeSessionId of input.claudeNativeSessionIds) {
              const match = yield* agentTranscriptHistoryIndex.findClaudeSubagent({
                parentNativeSessionId,
                agentRunId: row.agentRunId,
                launchToolUseId: row.launchToolUseId,
              });
              if (match !== null) matches.set(match.id, match);
            }
            if (matches.size === 1) {
              discoveredHistorySessionId = matches.values().next().value?.id ?? null;
            }
          } else if (
            hasOwnershipProof &&
            row.provider === "codex" &&
            row.launchToolUseId !== null &&
            input.parentCwd !== null
          ) {
            const launch = findCodexLaunchInvocation(row.launchToolUseId, input.activities);
            if (launch !== null && launch.invocation.resumeLast !== true) {
              const shellCwd = NodePath.resolve(input.parentCwd, launch.invocation.shellCwd ?? ".");
              const cwd = NodePath.resolve(shellCwd, launch.invocation.cwd ?? ".");
              const prompt = yield* Effect.promise(() =>
                resolveCodexCliInvocationPrompt({
                  invocation: launch.invocation,
                  parentCwd: input.parentCwd!,
                }),
              );
              if (prompt !== null) {
                const link = yield* Effect.tryPromise({
                  try: () =>
                    discoverCodexCliRollout({
                      ...(codexHome ? { codexHome } : {}),
                      cwd,
                      prompt,
                      startedAt: launch.activity.createdAt,
                    }),
                  catch: () => null,
                }).pipe(Effect.orElseSucceed(() => null));
                discoveredHistorySessionId = link?.historySessionId ?? null;
                if (link !== null) {
                  const terminal = yield* Effect.tryPromise({
                    try: () => readCodexCliRolloutTerminal(link.path, row.startedAt),
                    catch: () => null,
                  }).pipe(Effect.orElseSucceed(() => null));
                  if (terminal !== null) {
                    discoveredStatus = terminal.status;
                  } else {
                    const live = yield* Effect.tryPromise({
                      try: () => probeCodexCliRolloutLiveness(link.path),
                      catch: () => null,
                    }).pipe(Effect.orElseSucceed(() => null));
                    discoveredStatus =
                      live === true
                        ? "running"
                        : live === false
                          ? "stopped"
                          : launch.invocation.detached
                            ? "running"
                            : null;
                  }
                }
              }
            }
          }

          if (discoveredHistorySessionId !== null) {
            return yield* persistState(
              row,
              discoveredHistorySessionId,
              "linked",
              discoveredStatus,
            ).pipe(
              Effect.catch(() =>
                persistState(row, null, "unavailable").pipe(
                  Effect.orElseSucceed(
                    () =>
                      ({
                        ...row,
                        historySessionId: null,
                        transcriptState: "unavailable",
                      }) satisfies ProjectionAgentRun,
                  ),
                ),
              ),
            );
          }

          const transcriptState: ProjectionAgentRun["transcriptState"] =
            row.status === "running" || row.status === "paused" ? "pending" : "unavailable";
          if (row.historySessionId === null && row.transcriptState === transcriptState) return row;
          return yield* persistState(row, null, transcriptState).pipe(
            Effect.orElseSucceed(
              () =>
                ({
                  ...row,
                  historySessionId: null,
                  transcriptState,
                }) satisfies ProjectionAgentRun,
            ),
          );
        }),
      { concurrency: 1 },
    );
  });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.gen(function* () {
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        agentRunRows,
        claudeNativeSessionRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        listAgentRunRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listAgentRuns:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listAgentRuns:decodeRows",
            ),
          ),
        ),
        listClaudeNativeSessionRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listClaudeNativeSessions:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listClaudeNativeSessions:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const projectRow = yield* getActiveProjectRowById({
        projectId: threadRow.value.projectId,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:getProject:query",
            "ProjectionSnapshotQuery.getThreadDetailById:getProject:decodeRow",
          ),
        ),
      );
      const activities: ReadonlyArray<OrchestrationThreadActivity> = activityRows.map((row) => {
        const activity = {
          id: row.activityId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          turnId: row.turnId,
          createdAt: row.createdAt,
        };
        if (row.sequence !== null) {
          return Object.assign(activity, { sequence: row.sequence });
        }
        return activity;
      });
      const parentCwd =
        threadRow.value.worktreePath ??
        (Option.isSome(projectRow) ? projectRow.value.workspaceRoot : null);
      const reconciledAgentRunRows = yield* reconcileAgentRunHistories({
        parentCwd,
        activities,
        rows: agentRunRows,
        claudeNativeSessionIds: new Set(claudeNativeSessionRows.map((row) => row.nativeSessionId)),
      });

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        sideOfThreadId: threadRow.value.sideOfThreadId,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        deletedAt: null,
        messages: messageRows.map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          if (row.attachments !== null) {
            return Object.assign(message, { attachments: row.attachments });
          }
          return message;
        }),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        activities,
        agentRuns: reconciledAgentRunRows.map(mapAgentRunRow),
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        goal: threadRow.value.goal,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadDetailSnapshot: ProjectionSnapshotQueryShape["getThreadDetailSnapshot"] = (
    threadId,
  ) =>
    // Read the thread detail and the snapshot sequence within a single
    // transaction so the sequence is consistent with the returned state; a
    // projector update landing between two separate reads could otherwise return
    // a sequence ahead of the thread detail, causing the client to resume from
    // too far and drop events.
    sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* getThreadDetailById(threadId);
          if (Option.isNone(thread)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }
          const { snapshotSequence } = yield* getSnapshotSequence();
          return Option.some({ snapshotSequence, thread: thread.value });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshot:transaction")(
                error,
              ),
        ),
      );

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getArchivedShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    getThreadDetailById,
    getThreadDetailSnapshot,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
