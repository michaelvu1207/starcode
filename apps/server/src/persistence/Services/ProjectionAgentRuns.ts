import {
  AgentRunProvider,
  AgentRunStatus,
  AgentRunTranscriptState,
  HistorySessionId,
  IsoDateTime,
  ThreadId,
} from "@starcode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionAgentRun = Schema.Struct({
  parentThreadId: ThreadId,
  provider: AgentRunProvider,
  agentRunId: Schema.String,
  launchToolUseId: Schema.NullOr(Schema.String),
  taskType: Schema.NullOr(Schema.String),
  agentType: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  status: AgentRunStatus,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  historySessionId: Schema.NullOr(HistorySessionId),
  transcriptState: AgentRunTranscriptState,
  parentNativeSessionId: Schema.NullOr(Schema.String),
});
export type ProjectionAgentRun = typeof ProjectionAgentRun.Type;

export interface ProjectionAgentRunRepositoryShape {
  readonly upsert: (row: ProjectionAgentRun) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByParentThreadId: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionAgentRun>, ProjectionRepositoryError>;
  readonly replaceHistoryLink: (input: {
    readonly parentThreadId: ThreadId;
    readonly provider: ProjectionAgentRun["provider"];
    readonly agentRunId: string;
    readonly historySessionId: ProjectionAgentRun["historySessionId"];
    readonly transcriptState: ProjectionAgentRun["transcriptState"];
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByParentThreadId: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionAgentRunRepository extends Context.Service<
  ProjectionAgentRunRepository,
  ProjectionAgentRunRepositoryShape
>()("starcode/persistence/Services/ProjectionAgentRuns/ProjectionAgentRunRepository") {}
