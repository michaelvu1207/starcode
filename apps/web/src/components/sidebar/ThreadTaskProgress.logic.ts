/**
 * threadTaskProgress - Segment math for the sidebar row's task-progress bar.
 *
 * A thread's agent task list (TodoWrite / update_plan) reaches the sidebar as
 * the optional `planSummary` rollup on its shell. This module turns that rollup
 * into a render-ready model so the component stays presentational and the
 * awkward parts — the segment cap, clamping a summary that disagrees with
 * itself, reduced motion — are unit-testable.
 *
 * @module threadTaskProgress
 */
import type { OrchestrationThreadPlanSummary } from "@starcode/contracts";

/**
 * Past this many tasks, individual segments are thinner than the gaps between
 * them and stop reading as a count. Longer lists collapse to one continuous bar
 * plus a "7/15" label, which stays legible at any length.
 */
export const MAX_TASK_PROGRESS_SEGMENTS = 12;

/**
 * How full the in-progress segment renders. The step is started but has no
 * partial-completion signal of its own, so this is a fixed hint that work has
 * begun there — not a measurement.
 */
export const ACTIVE_SEGMENT_FILL = 0.45;

export type ThreadTaskSegmentState = "completed" | "active" | "pending";

export interface ThreadTaskSegment {
  readonly state: ThreadTaskSegmentState;
  /** 0–1 share of this segment that is filled. */
  readonly fill: number;
}

export interface ThreadTaskProgressModel {
  readonly total: number;
  readonly completed: number;
  /** 0–1 share of the whole bar that is filled. */
  readonly fraction: number;
  readonly mode: "segmented" | "continuous";
  readonly segments: ReadonlyArray<ThreadTaskSegment>;
  readonly countLabel: string;
  /** Segmented bars are their own count; only continuous bars need the label. */
  readonly showCountLabel: boolean;
  /** False under prefers-reduced-motion: fills jump instead of easing. */
  readonly animate: boolean;
  readonly label: string;
}

function clampCompleted(completed: number, total: number): number {
  if (!Number.isFinite(completed) || completed < 0) return 0;
  return Math.min(Math.floor(completed), total);
}

/**
 * Whether a bar would render at all. Call sites need this before the component
 * exists so they can keep their layout spacer when it would not.
 */
export function hasThreadTaskProgress(
  summary: OrchestrationThreadPlanSummary | null | undefined,
): boolean {
  return buildThreadTaskProgress({ summary, reducedMotion: false }) !== null;
}

/**
 * Build the row's progress model, or null when there is nothing to draw
 * (no summary — including servers that never send one — or an empty plan).
 */
export function buildThreadTaskProgress(input: {
  readonly summary: OrchestrationThreadPlanSummary | null | undefined;
  readonly reducedMotion: boolean;
}): ThreadTaskProgressModel | null {
  const summary = input.summary;
  if (summary === null || summary === undefined) {
    return null;
  }
  const total = Number.isFinite(summary.total) ? Math.floor(summary.total) : 0;
  if (total <= 0) {
    return null;
  }
  const completed = clampCompleted(summary.completed, total);
  const fraction = completed / total;
  const isDone = completed >= total;
  const activeStep = summary.activeStep ?? null;

  const segments: Array<ThreadTaskSegment> =
    total <= MAX_TASK_PROGRESS_SEGMENTS
      ? Array.from({ length: total }, (_unused, index): ThreadTaskSegment => {
          if (index < completed) return { state: "completed", fill: 1 };
          if (index === completed && !isDone) {
            return { state: "active", fill: ACTIVE_SEGMENT_FILL };
          }
          return { state: "pending", fill: 0 };
        })
      : [{ state: isDone ? "completed" : "active", fill: fraction }];

  const countLabel = `${completed}/${total}`;
  return {
    total,
    completed,
    fraction,
    mode: total <= MAX_TASK_PROGRESS_SEGMENTS ? "segmented" : "continuous",
    segments,
    countLabel,
    showCountLabel: total > MAX_TASK_PROGRESS_SEGMENTS,
    animate: !input.reducedMotion,
    label: activeStep === null ? `Tasks ${countLabel}` : `Tasks ${countLabel} — ${activeStep}`,
  };
}
