/**
 * The regression this file exists for: the button did nothing.
 *
 * The picker path shipped composed as `PopoverTrigger render={<Tooltip>…}`.
 * That type-checks, renders a button that looks exactly right, and is inert —
 * base UI spreads the popover's trigger props onto `Tooltip`, which is a
 * context-only Root with no DOM element to carry them, so no handler ever
 * reaches the `<button>`. Nothing about the rendered output looks wrong unless
 * you know which attributes to expect, which is precisely why the round's
 * ranking tests all passed while the feature was unusable.
 *
 * So the assertions here are about the wiring rather than the appearance: a
 * button that opens a popover carries base UI's own trigger attributes, and a
 * button that acts immediately must not.
 */
import { EnvironmentId, ProjectId, type ProjectCategorySlug } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectStartLocation } from "../projects/ProjectThreadStart.model";
import { SidebarProjectNewThread } from "./SidebarProjectNewThread";

const location = (id: string, bound: boolean): ProjectStartLocation => ({
  environmentId: EnvironmentId.make("env-hub"),
  projectId: ProjectId.make(id),
  title: id,
  machineLabel: "hub",
  isLocalMachine: false,
  bound,
});

const render = (locations: ReadonlyArray<ProjectStartLocation>): string =>
  renderToStaticMarkup(
    <SidebarProjectNewThread
      slug={"atlas" as ProjectCategorySlug}
      title="Atlas"
      locations={locations}
      onStart={() => {}}
    />,
  );

describe("SidebarProjectNewThread", () => {
  it("wires the button to the popover when there is a choice to make", () => {
    // A project with no folder of its own, and a project with several: both
    // have to ask, and both were inert.
    for (const locations of [
      [location("p-1", false)],
      [location("p-1", true), location("p-2", true)],
    ]) {
      const markup = render(locations);
      expect(markup).toContain('data-testid="sidebar-v2-project-new-thread"');
      // Base UI's own click-trigger wiring, landed on the real element. Note
      // it is NOT `data-slot="popover-trigger"`: the tooltip wraps the popover
      // trigger, so the outer slot name wins. These two attributes are the ones
      // that only exist when the popover actually reached the button.
      expect(markup).toContain("data-base-ui-click-trigger");
      expect(markup).toContain('aria-haspopup="dialog"');
    }
  });

  it("leaves the button plain when one bound folder makes the choice for it", () => {
    const markup = render([location("p-1", true)]);

    expect(markup).toContain('data-testid="sidebar-v2-project-new-thread"');
    // No popover: this one acts on click, and a dialog-haspopup would promise a
    // menu that never opens.
    expect(markup).not.toContain('aria-haspopup="dialog"');
  });

  it("keeps the tooltip on both paths, so the icon is never unlabelled", () => {
    expect(render([location("p-1", true)])).toContain('aria-label="New thread in Atlas"');
    expect(render([location("p-1", false)])).toContain('aria-label="New thread in Atlas"');
  });

  it("renders nothing when no machine has reported a folder to start in", () => {
    expect(render([])).toBe("");
  });
});
