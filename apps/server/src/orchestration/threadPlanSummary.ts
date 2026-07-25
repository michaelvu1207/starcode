/**
 * threadPlanSummary - Fold a `turn.plan.updated` activity payload into the
 * row-level rollup carried by thread shells.
 *
 * Kept pure and separate from the snapshot query so the parsing rules are
 * testable on their own and the query keeps a call-site-sized diff. The rules
 * mirror the client's `deriveActivePlanState`: unknown step statuses degrade to
 * "pending" rather than dropping the step, because a plan we half-understand is
 * still a plan the user can watch progress against.
 *
 * @module threadPlanSummary
 */
import type { OrchestrationThreadPlanSummary } from "@t3tools/contracts";

type PlanStepStatus = "pending" | "inProgress" | "completed";

interface ParsedPlanStep {
  readonly step: string;
  readonly status: PlanStepStatus;
}

function parseSteps(payload: unknown): ReadonlyArray<ParsedPlanStep> {
  if (payload === null || typeof payload !== "object") {
    return [];
  }
  const rawPlan = (payload as Record<string, unknown>).plan;
  if (!Array.isArray(rawPlan)) {
    return [];
  }
  const steps: Array<ParsedPlanStep> = [];
  for (const entry of rawPlan) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.step !== "string") {
      continue;
    }
    steps.push({
      step: record.step,
      status:
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending",
    });
  }
  return steps;
}

/**
 * Reduce a plan payload to `{ total, completed, activeStep }`, or null when the
 * payload carries no usable steps.
 */
export function derivePlanSummary(payload: unknown): OrchestrationThreadPlanSummary | null {
  const steps = parseSteps(payload);
  if (steps.length === 0) {
    return null;
  }
  const completed = steps.filter((step) => step.status === "completed").length;
  const active =
    steps.find((step) => step.status === "inProgress") ??
    steps.find((step) => step.status === "pending") ??
    null;
  // The contract types activeStep as a trimmed non-empty string: a whitespace
  // step label is data we cannot represent, so it degrades to "no active step"
  // rather than failing the whole shell decode.
  const activeStep = active === null ? null : active.step.trim();
  return {
    total: steps.length,
    completed,
    activeStep: activeStep === null || activeStep.length === 0 ? null : activeStep,
  };
}
