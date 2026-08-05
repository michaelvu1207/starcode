/**
 * The heading a plan names itself by.
 *
 * Shared between the plan panel and the thread renamer, so a change here moves
 * both the title above a plan and the name of the thread in the sidebar. They
 * have to stay the same string — a thread called something the plan never says
 * is worse than a thread with a stale name.
 */
import { describe, expect, it } from "vite-plus/test";

import { proposedPlanTitle } from "./proposedPlanTitle.ts";

describe("proposedPlanTitle", () => {
  it("takes the first heading as the plan's name", () => {
    expect(proposedPlanTitle("# Local thread_create\n\nSome body.")).toBe("Local thread_create");
  });

  it("accepts a heading at any level", () => {
    // Plans get written by models and by hand; one that opens with `##` is
    // naming itself just as much as one that opens with `#`.
    expect(proposedPlanTitle("## Subagent task panel\n\nBody.")).toBe("Subagent task panel");
  });

  it("finds the heading when the plan opens with prose", () => {
    expect(proposedPlanTitle("Some preamble.\n\n# The actual plan\n")).toBe("The actual plan");
  });

  it("returns null for a plan that never names itself", () => {
    // The renamer treats this as "leave the thread alone" rather than inventing
    // a title from the body.
    expect(proposedPlanTitle("Just prose, no heading anywhere.")).toBeNull();
    expect(proposedPlanTitle("")).toBeNull();
  });

  it("ignores a hash that is not a heading", () => {
    expect(proposedPlanTitle("#nothashheading\n")).toBeNull();
  });
});
