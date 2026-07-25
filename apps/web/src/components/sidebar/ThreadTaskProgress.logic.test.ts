import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVE_SEGMENT_FILL,
  MAX_TASK_PROGRESS_SEGMENTS,
  buildThreadTaskProgress,
  hasThreadTaskProgress,
} from "./ThreadTaskProgress.logic";

const build = (
  summary: { total: number; completed: number; activeStep: string | null } | null | undefined,
  reducedMotion = false,
) => buildThreadTaskProgress({ summary, reducedMotion });

describe("buildThreadTaskProgress", () => {
  it("renders nothing when the server sends no summary", () => {
    // Servers that predate planSummary omit the key entirely; the bar has to
    // degrade to absent rather than to an empty bar.
    expect(build(undefined)).toBeNull();
    expect(build(null)).toBeNull();
    expect(hasThreadTaskProgress(undefined)).toBe(false);
  });

  it("renders nothing for an empty plan", () => {
    expect(build({ total: 0, completed: 0, activeStep: null })).toBeNull();
  });

  it("gives one segment per task and fills the completed ones", () => {
    const model = build({ total: 4, completed: 2, activeStep: "Write the tests" });
    expect(model?.mode).toBe("segmented");
    expect(model?.segments).toEqual([
      { state: "completed", fill: 1 },
      { state: "completed", fill: 1 },
      { state: "active", fill: ACTIVE_SEGMENT_FILL },
      { state: "pending", fill: 0 },
    ]);
    expect(model?.fraction).toBe(0.5);
    expect(model?.label).toBe("Tasks 2/4 — Write the tests");
  });

  it("has no active segment once every task is done", () => {
    const model = build({ total: 3, completed: 3, activeStep: null });
    expect(model?.segments.every((segment) => segment.state === "completed")).toBe(true);
    expect(model?.label).toBe("Tasks 3/3");
  });

  it("keeps segments at the cap and collapses past it", () => {
    const atCap = build({
      total: MAX_TASK_PROGRESS_SEGMENTS,
      completed: 3,
      activeStep: "Step 4",
    });
    expect(atCap?.mode).toBe("segmented");
    expect(atCap?.segments).toHaveLength(MAX_TASK_PROGRESS_SEGMENTS);
    expect(atCap?.showCountLabel).toBe(false);

    const overCap = build({
      total: MAX_TASK_PROGRESS_SEGMENTS + 3,
      completed: 7,
      activeStep: "Step 8",
    });
    expect(overCap?.mode).toBe("continuous");
    expect(overCap?.segments).toEqual([{ state: "active", fill: 7 / 15 }]);
    expect(overCap?.showCountLabel).toBe(true);
    expect(overCap?.countLabel).toBe("7/15");
  });

  it("clamps a summary that disagrees with itself", () => {
    // A shell is decoded data, not a computation we control: over-count,
    // negative, and fractional values must all still draw a sane bar.
    expect(build({ total: 3, completed: 9, activeStep: null })?.segments).toEqual([
      { state: "completed", fill: 1 },
      { state: "completed", fill: 1 },
      { state: "completed", fill: 1 },
    ]);
    expect(build({ total: 3, completed: -2, activeStep: null })?.completed).toBe(0);
    expect(build({ total: 3, completed: 1.8, activeStep: null })?.completed).toBe(1);
  });

  it("drops the animation flag under reduced motion", () => {
    expect(build({ total: 4, completed: 1, activeStep: "Step 2" })?.animate).toBe(true);
    expect(build({ total: 4, completed: 1, activeStep: "Step 2" }, true)?.animate).toBe(false);
  });
});
