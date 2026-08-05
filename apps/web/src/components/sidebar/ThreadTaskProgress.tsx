/**
 * ThreadTaskProgress - Slim segmented task-progress bar for a sidebar thread row.
 *
 * One segment per task in the thread's active task list, filling left to right
 * as steps complete. Rows are the densest surface in the app, so the bar is
 * 3px tall and carries no text until the list is long enough that individual
 * segments stop being countable.
 *
 * @module ThreadTaskProgress
 */
import type { OrchestrationThreadPlanSummary } from "@starcode/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";

import { buildThreadTaskProgress } from "./ThreadTaskProgress.logic";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/**
 * The `motion-reduce:` variants below already stop the animation in CSS; the
 * hook exists so the pulse element is not rendered at all, and so the segment
 * math can be asserted against the flag in tests.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    readReducedMotion,
    // Server/prerender: assume motion is fine, matching the rest of the app.
    () => false,
  );
}

export function ThreadTaskProgress(props: {
  summary: OrchestrationThreadPlanSummary | null | undefined;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const model = useMemo(
    () => buildThreadTaskProgress({ summary: props.summary, reducedMotion }),
    [props.summary, reducedMotion],
  );
  if (model === null) {
    return null;
  }
  const segmentCount = model.segments.length;
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", props.className)}>
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={model.total}
        aria-valuenow={model.completed}
        aria-label={model.label}
        className="flex h-[3px] min-w-0 flex-1 items-stretch gap-[2px]"
      >
        {model.segments.map((segment, index) => (
          <span
            // Segments are positional by definition — task N is the Nth slot.
            key={index}
            className="relative min-w-0 flex-1 overflow-hidden rounded-full bg-muted-foreground/20"
          >
            {/* One gradient spans the whole bar: each segment shows its own
                slice of it, so the fill reads as a single sweep rather than N
                repeated mini-gradients. The slice is revealed by clip-path
                (rather than a width or scale) so animating it never stretches
                the gradient. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 rounded-full bg-linear-to-r from-success to-teal-400",
                model.animate && "transition-[clip-path] duration-500 ease-out",
                "motion-reduce:transition-none",
                segment.state === "active" &&
                  model.animate &&
                  "animate-status-pulse motion-reduce:animate-none",
              )}
              style={{
                width: `${segmentCount * 100}%`,
                left: `${-index * 100}%`,
                clipPath: `inset(0 ${(1 - (index + segment.fill) / segmentCount) * 100}% 0 0)`,
              }}
            />
          </span>
        ))}
      </span>
      {model.showCountLabel ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {model.countLabel}
        </span>
      ) : null}
    </span>
  );
}
