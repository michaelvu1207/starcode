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
import { EnvironmentId, ProjectId, type ProjectCategorySlug } from "@starcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  ProjectStartConnection,
  ProjectStartLocation,
} from "../projects/ProjectThreadStart.model";
import { ProjectStartPicker, SidebarProjectNewThread } from "./SidebarProjectNewThread";

const HUB = EnvironmentId.make("env-hub");
const LAPTOP = EnvironmentId.make("env-laptop");

const location = (
  id: string,
  bound: boolean,
  environmentId: EnvironmentId = HUB,
): ProjectStartLocation => ({
  environmentId,
  projectId: ProjectId.make(id),
  title: id,
  machineLabel: environmentId === HUB ? "hub" : "laptop",
  isLocalMachine: false,
  bound,
});

const connection = (
  environmentId: EnvironmentId,
  locations: ReadonlyArray<ProjectStartLocation>,
): ProjectStartConnection => ({
  environmentId,
  machineLabel: environmentId === HUB ? "hub" : "laptop",
  isLocalMachine: false,
  locations,
});

const render = (connections: ReadonlyArray<ProjectStartConnection>): string =>
  renderToStaticMarkup(
    <SidebarProjectNewThread
      slug={"atlas" as ProjectCategorySlug}
      title="Atlas"
      connections={connections}
      onStart={() => {}}
    />,
  );

const ONE_UNBOUND = [connection(HUB, [location("p-1", false)])];
const TWO_BOUND = [connection(HUB, [location("p-1", true), location("p-2", true)])];

describe("SidebarProjectNewThread", () => {
  it("wires the button to the popover when there is a choice to make", () => {
    // A project with no folder of its own, and a project with several: both
    // have to ask, and both were inert.
    for (const connections of [ONE_UNBOUND, TWO_BOUND]) {
      const markup = render(connections);
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
    const markup = render([connection(HUB, [location("p-1", true)])]);

    expect(markup).toContain('data-testid="sidebar-v2-project-new-thread"');
    // No popover: this one acts on click, and a dialog-haspopup would promise a
    // menu that never opens.
    expect(markup).not.toContain('aria-haspopup="dialog"');
  });

  it("keeps the tooltip on both paths, so the icon is never unlabelled", () => {
    expect(render([connection(HUB, [location("p-1", true)])])).toContain(
      'aria-label="New thread in Atlas"',
    );
    expect(render(ONE_UNBOUND)).toContain('aria-label="New thread in Atlas"');
  });

  it("renders nothing when no machine has reported a folder to start in", () => {
    expect(render([])).toBe("");
  });
});

describe("the picker's list", () => {
  // A closed popover renders nothing, so the list is asserted on its own
  // component — the one `PopoverPopup` renders when it opens.
  const list = (connections: ReadonlyArray<ProjectStartConnection>): string =>
    renderToStaticMarkup(
      <ProjectStartPicker title="Atlas" connections={connections} onPick={() => {}} />,
    );

  const twoMachines = list([
    connection(HUB, [location("p-1", true), location("p-2", true)]),
    connection(LAPTOP, [location("p-3", true, LAPTOP)]),
  ]);

  it("heads each machine with its own mark and name", () => {
    expect(twoMachines).toContain('data-testid="sidebar-v2-project-new-thread-connection"');
    // The mark is keyed on the environment id, so the group carries the id too
    // and a screenshot is not the only way to tell the groups apart.
    expect(twoMachines).toContain('data-environment-id="env-hub"');
    expect(twoMachines).toContain('data-environment-id="env-laptop"');
    expect(twoMachines).toContain('data-testid="connection-mark"');
  });

  it("says which project the thread lands in, since it is never a choice", () => {
    expect(twoMachines).toContain("New thread in Atlas, on which machine?");
  });

  it("never offers a start outside the project", () => {
    // The old picker had an "Elsewhere" section for folders the project had not
    // claimed. Clicking + on a project means a thread in that project.
    expect(twoMachines).not.toContain("Elsewhere");
    expect(list(ONE_UNBOUND)).not.toContain("Elsewhere");
  });

  it("offers every folder it was handed, one row each", () => {
    const rows = twoMachines.split('data-testid="sidebar-v2-project-new-thread-location"').length;
    expect(rows - 1).toBe(3);
  });

  it("admits it is guessing when the project has claimed no folder", () => {
    expect(list(ONE_UNBOUND)).toContain("Atlas has no folder of its own yet");
    // …and does not say it when the folders are the project's own.
    expect(twoMachines).not.toContain("has no folder of its own yet");
  });
});
