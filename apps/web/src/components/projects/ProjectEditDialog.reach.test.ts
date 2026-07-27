/**
 * Where the project actions live now.
 *
 * F16.6 deleted two surfaces — the global index and the project home's header
 * strip — and everything they carried had to land somewhere or quietly stop
 * existing. This asserts the landings, because "unreachable" is the one bug a
 * type checker cannot see: every one of these still compiles perfectly with no
 * caller at all.
 *
 * Source-level for the same reason `ProjectHomeView.layout.test.ts` is: the
 * claim is about what the app offers, and a rendering test of one dialog would
 * pass just as happily with the dialog rendered by nobody.
 */
import { describe, expect, it } from "vite-plus/test";

import editSource from "./ProjectEditDialog.tsx?raw";
import menuSource from "../sidebar/SidebarProjectsMenu.tsx?raw";
import sidebarEditSource from "../sidebar/SidebarProjectEdit.tsx?raw";
import projectsRouteSource from "../../routes/_chat.projects.tsx?raw";

describe("the edit dialog, after the header strip was deleted", () => {
  it("carries archive and delete", () => {
    expect(editSource).toContain('data-testid="project-archive"');
    expect(editSource).toContain('data-testid="project-delete"');
    expect(editSource).toContain("<ProjectDeleteDialog");
  });

  it("opens the confirmation beside itself rather than on top of itself", () => {
    // The delete button closes this dialog before opening the next one. Two
    // popups deep is where Escape stops being predictable.
    expect(editSource).toMatch(/onOpenChange\(false\);\s*setConfirmingDelete\(true\);/);
  });

  it("carries the bind suggestions the index's strip used to show", () => {
    expect(editSource).toContain("<ProjectBindSuggestions");
    expect(editSource).toContain("seedPlan.bindSuggestions");
    expect(editSource).toContain("writer.bind(suggestion)");
  });

  it("is reachable without the project home, from the sidebar's pencil", () => {
    expect(sidebarEditSource).toContain("<ProjectEditDialog");
    expect(sidebarEditSource).toContain('data-testid="sidebar-v2-project-edit"');
  });
});

describe("the sidebar popover, after the index was deleted", () => {
  it("still makes projects and folders", () => {
    expect(menuSource).toContain('data-testid="sidebar-projects-new-category"');
    expect(menuSource).toContain('data-testid="sidebar-projects-new-folder"');
  });

  it("carries seeding, which used to be reachable only before the first project", () => {
    expect(menuSource).toContain('data-testid="sidebar-projects-seed"');
    expect(menuSource).toContain("<ProjectSeedDialog");
    // Hidden when there is nothing to propose, rather than opening an empty
    // dialog to say so.
    expect(menuSource).toContain("seedPlan.proposals.length > 0");
  });

  it("no longer offers a door to a page that does not exist", () => {
    expect(menuSource).not.toContain("All projects");
    expect(menuSource).not.toContain('to="/projects"');
  });
});

describe("/projects", () => {
  it("redirects instead of rendering or 404ing", () => {
    expect(projectsRouteSource).toContain('redirect({ to: "/" })');
    expect(projectsRouteSource).not.toContain("ProjectsIndexView");
  });
});
