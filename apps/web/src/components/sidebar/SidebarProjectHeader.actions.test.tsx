/**
 * The three controls on a project heading, and which of them you have to hover
 * to find.
 *
 * Michael, on opening the fork: *"I would make sure the map for each project is
 * visible by default. You should not have to highlight it."* The map was
 * `opacity-0` until the heading was hovered, so the only route to a project's
 * own home was one you had to already know about. Opacity is exactly the kind of
 * fact a render cannot settle — the element is in the markup either way, with
 * identical attributes but for one class — which is why the assertions here read
 * the class strings and the source rather than looking for elements. Same
 * reasoning as `ChatsDock.layout.test.ts`, and the same limit: a browser is
 * still where this is *seen*, this is where the next person to touch it finds
 * out.
 */
import type { ProjectCategorySlug } from "@starcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectCategoryView } from "../projects/ProjectCatalog.model";
import { SidebarProjectEdit } from "./SidebarProjectEdit";
import {
  SIDEBAR_PROJECT_ACTION_CLASS,
  SIDEBAR_PROJECT_ACTION_PERSISTENT_CLASS,
} from "./SidebarProjectHeaderActions";
import projectsViewSource from "./SidebarProjectsView.tsx?raw";

/** The one line that draws the map link, which is the whole subject here. */
const mapLinkBlock =
  projectsViewSource
    .split("<Link")
    .find((block) => block.includes('data-testid="sidebar-v2-project-group-open"')) ?? "";

const project: ProjectCategoryView = {
  slug: "atlas" as ProjectCategorySlug,
  display: {
    title: "Atlas",
    summary: "",
    accent: "",
    glyph: "",
    icon: "",
    parentSlug: null,
    links: [],
    notes: "",
    archivedAt: null,
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
  createdAt: "2026-07-01T00:00:00.000Z",
  archived: false,
  sections: [],
  staleEnvironmentIds: [],
};

describe("the map into a project's home", () => {
  it("is drawn without being hovered", () => {
    // The regression, stated as the two classes that caused it. `opacity-0` is
    // the one that hid it; `group-hover/project:opacity-100` is the one that
    // made hovering the only way back. Either one returning is the bug.
    expect(mapLinkBlock).toContain("SIDEBAR_PROJECT_ACTION_PERSISTENT_CLASS");
    expect(SIDEBAR_PROJECT_ACTION_PERSISTENT_CLASS).not.toContain("opacity-0");
    expect(SIDEBAR_PROJECT_ACTION_PERSISTENT_CLASS).not.toContain("group-hover");
  });

  it("still reads as chrome rather than as a primary control", () => {
    // Permanent is not the same as loud. It sits at the muted weight the rest
    // of the heading's controls use and brightens on hover like they do —
    // otherwise "always visible" turns into a row of buttons shouting over the
    // project names they are attached to.
    expect(SIDEBAR_PROJECT_ACTION_PERSISTENT_CLASS).toContain("text-muted-foreground/50");
    expect(SIDEBAR_PROJECT_ACTION_PERSISTENT_CLASS).toContain("hover:text-foreground");
  });
});

describe("the heading's secondary controls", () => {
  it("fade in on hover and on keyboard focus", () => {
    expect(SIDEBAR_PROJECT_ACTION_CLASS).toContain("opacity-0");
    expect(SIDEBAR_PROJECT_ACTION_CLASS).toContain("group-hover/project:opacity-100");
    // Without this a fade-in control is a mouse-only control. Tabbing to a
    // button you cannot see is worse than not having it.
    expect(SIDEBAR_PROJECT_ACTION_CLASS).toContain("focus-visible:opacity-100");
  });

  it("reserves its space at rest, so nothing reflows under the pointer", () => {
    // `opacity`, never `hidden`: the heading's controls all occupy their box
    // whether or not they are painted. This is also why making the map
    // permanent moved nothing — it was already taking up the room.
    expect(SIDEBAR_PROJECT_ACTION_CLASS).not.toContain("hidden");
    expect(SIDEBAR_PROJECT_ACTION_CLASS).toContain("shrink-0");
  });
});

describe("SidebarProjectEdit", () => {
  const markup = renderToStaticMarkup(
    <SidebarProjectEdit project={project} onSave={async () => {}} />,
  );

  it("names the project it edits, so the icon is never unlabelled", () => {
    expect(markup).toContain('aria-label="Edit Atlas"');
    expect(markup).toContain('data-testid="sidebar-v2-project-edit"');
  });

  it("is a plain button, not a promise of a menu", () => {
    // One thing sits behind it. `aria-haspopup="dialog"` here would be the
    // popover wiring, and this is not a popover — it opens the same dialog the
    // project home does.
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  it("reaches the sidebar heading through the shared action class", () => {
    expect(markup).toContain("opacity-0");
    expect(markup).toContain("group-hover/project:opacity-100");
  });

  it("does not carry delete", () => {
    // Stated as a test because the temptation to add it here is real and the
    // project home already explains why not: this heading is a target you hit
    // forty times a day, and the one irreversible action does not belong on it.
    expect(markup.toLowerCase()).not.toContain("delete");
  });
});

describe("the heading wires the pencil to the record behind it", () => {
  it("renders the pencil only for a project the fold answered for", () => {
    // A slug with no record has nothing to edit. The guard is what stops the
    // dialog opening over an undefined project and throwing on `display.title`.
    expect(projectsViewSource).toContain("editableProject === null ? null : (");
    expect(projectsViewSource).toContain("projectBySlug.get(group.slug) ?? null");
  });

  it("saves through the display fan-out, not a local write", () => {
    // `rename` carries the whole display patch to every connected machine,
    // which is what makes an icon or a title set here show up on the others.
    expect(projectsViewSource).toContain("writer.rename(editableProject.slug, patch)");
  });
});
