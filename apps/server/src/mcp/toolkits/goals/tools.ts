import {
  GoalGetToolInput,
  GoalGetToolResult,
  GoalProgressToolInput,
  GoalTerminalToolInput,
  GoalToolError,
  GoalToolResult,
} from "@starcode/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
  Crypto.Crypto,
];

const read = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

const write = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false) as T;

export const GoalGetTool = read(
  Tool.make("goal_get", {
    description: "Read the durable Starcode goal attached to your current thread.",
    parameters: GoalGetToolInput,
    success: GoalGetToolResult,
    failure: GoalToolError,
    dependencies,
  }).annotate(Tool.Title, "Read current goal"),
);

export const GoalProgressTool = write(
  Tool.make("goal_progress", {
    description: "Record a meaningful progress checkpoint for your active goal.",
    parameters: GoalProgressToolInput,
    success: GoalToolResult,
    failure: GoalToolError,
    dependencies,
  }).annotate(Tool.Title, "Record goal progress"),
);

export const GoalCompleteTool = write(
  Tool.make("goal_complete", {
    description: "Mark your current goal complete after its result has been verified.",
    parameters: GoalTerminalToolInput,
    success: GoalToolResult,
    failure: GoalToolError,
    dependencies,
  }).annotate(Tool.Title, "Complete goal"),
);

export const GoalBlockedTool = write(
  Tool.make("goal_blocked", {
    description: "Mark your current goal blocked only when autonomous progress is impossible.",
    parameters: GoalTerminalToolInput,
    success: GoalToolResult,
    failure: GoalToolError,
    dependencies,
  }).annotate(Tool.Title, "Block goal"),
);

export const GoalsToolkit = Toolkit.make(
  GoalGetTool,
  GoalProgressTool,
  GoalCompleteTool,
  GoalBlockedTool,
);
