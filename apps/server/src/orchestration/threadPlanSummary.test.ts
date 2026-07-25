import { describe, expect, it } from "@effect/vitest";

import { derivePlanSummary } from "./threadPlanSummary.ts";

describe("derivePlanSummary", () => {
  it("counts completed steps and names the in-progress one", () => {
    expect(
      derivePlanSummary({
        plan: [
          { step: "Read the spec", status: "completed" },
          { step: "Write the code", status: "inProgress" },
          { step: "Run the gates", status: "pending" },
        ],
      }),
    ).toEqual({ total: 3, completed: 1, activeStep: "Write the code" });
  });

  it("falls back to the first pending step when nothing is in progress", () => {
    expect(
      derivePlanSummary({
        plan: [
          { step: "Read the spec", status: "completed" },
          { step: "Write the code", status: "pending" },
          { step: "Run the gates", status: "pending" },
        ],
      }),
    ).toEqual({ total: 3, completed: 1, activeStep: "Write the code" });
  });

  it("has no active step once every step is complete", () => {
    expect(
      derivePlanSummary({
        plan: [
          { step: "Read the spec", status: "completed" },
          { step: "Write the code", status: "completed" },
        ],
      }),
    ).toEqual({ total: 2, completed: 2, activeStep: null });
  });

  it("treats an unrecognized status as pending rather than dropping the step", () => {
    // Adapters differ on plan vocabulary; a step we half-understand still
    // belongs in the count.
    expect(
      derivePlanSummary({
        plan: [
          { step: "Read the spec", status: "completed" },
          { step: "Write the code", status: "in_progress" },
        ],
      }),
    ).toEqual({ total: 2, completed: 1, activeStep: "Write the code" });
  });

  it("returns null for payloads that carry no usable steps", () => {
    expect(derivePlanSummary(null)).toBeNull();
    expect(derivePlanSummary("nope")).toBeNull();
    expect(derivePlanSummary({})).toBeNull();
    expect(derivePlanSummary({ plan: [] })).toBeNull();
    expect(derivePlanSummary({ plan: [{ status: "pending" }, null, 7] })).toBeNull();
  });

  it("trims the active step and drops it when it is blank", () => {
    // activeStep is typed as a trimmed non-empty string; a whitespace label
    // must not fail the surrounding shell decode.
    expect(
      derivePlanSummary({ plan: [{ step: "  Write the code  ", status: "pending" }] }),
    ).toEqual({ total: 1, completed: 0, activeStep: "Write the code" });
    expect(derivePlanSummary({ plan: [{ step: "   ", status: "pending" }] })).toEqual({
      total: 1,
      completed: 0,
      activeStep: null,
    });
  });
});
