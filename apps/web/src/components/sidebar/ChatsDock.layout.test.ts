/**
 * The facts that make the Chats section dock, checked against the source.
 *
 * Read from the source and not from a render, because none of this is decidable
 * without a layout engine: `position: sticky` and `margin-top: auto` both do
 * exactly nothing wrong when they are broken — no error, no missing element,
 * markup identical either way. It shipped broken once for that reason, and what
 * a screenshot found was that the panel sat 69px above the sidebar floor.
 *
 * The browser is still where this gets verified. What these assertions buy is
 * that the *next* person to touch the chain finds out here, rather than from a
 * screenshot two rounds later.
 */
import { describe, expect, it } from "vite-plus/test";

import projectsViewSource from "./SidebarProjectsView.tsx?raw";
import sidebarSource from "../SidebarV2.tsx?raw";

/** The one line that declares the scroller and the group inside it. */
const groupLine =
  sidebarSource.split("\n").find((line) => line.includes("<SidebarGroup className=")) ?? "";
const contentLine =
  sidebarSource.split("\n").find((line) => line.includes("<SidebarContent className=")) ?? "";
const dockLine =
  projectsViewSource.split("\n").find((line) => line.includes('className="sc-chats-dock')) ?? "";

describe("the Chats dock's layout chain", () => {
  it("reaches a real height from the scroll viewport", () => {
    // `SidebarContent` is a ScrollArea whose viewport is the only element in
    // the chain with a height. Everything below it is content-sized, so without
    // this a percentage inside resolves against nothing and `mt-auto` has no
    // free space to consume.
    expect(contentLine).toContain("min-h-full");
  });

  it("lets the list fill the group rather than asking it for a percentage", () => {
    // `min-h-full` on the list was the original attempt and it silently did
    // nothing: the group's own height is decided by flex layout, which is not a
    // definite height for a percentage to resolve against. `flex-1` asks the
    // flex algorithm instead, which is the thing that actually knows.
    const listLine =
      sidebarSource.split("\n").find((line) => line.includes('className="flex flex-1 flex-col')) ??
      "";
    expect(listLine).toContain("flex-1");
    expect(listLine).not.toContain("min-h-full");
  });

  it("leaves no overflow between the sticky panel and the real scroller", () => {
    // An `overflow` other than `visible` here makes this element the scrollport
    // a sticky descendant sticks *within* — and this box never scrolls, so the
    // sticky range is zero and the dock silently stops docking. It never
    // scrolled anything either; the ScrollArea viewport above is the scroller.
    expect(groupLine).not.toContain("overflow-y-auto");
    expect(groupLine).not.toContain("overflow-auto");
    expect(groupLine).not.toContain("overflow-hidden");
  });

  it("floors the panel when the list is short and pins it when the list is long", () => {
    expect(dockLine).toContain("mt-auto");
    expect(dockLine).toContain("sticky");
    expect(dockLine).toContain("bottom-0");
  });

  it("keeps the gap and the fade outside the opaque panel", () => {
    // The sticky element carries the gap and the fade; the background lives on
    // a child. Painting the sticky element itself would put the panel's colour
    // over the very space the gap is, and there would be nothing to fade into.
    //
    // The rule itself is not asserted here: `?raw` on a stylesheet hands back an
    // empty string under this test runner — the CSS plugin claims the import
    // before the raw loader sees it — so what is checkable is that the class is
    // applied and its stylesheet is pulled in. The rule's own effect is verified
    // in a browser, which is the only place a gradient means anything.
    expect(dockLine).toContain("sc-chats-dock");
    expect(dockLine).not.toContain("bg-sidebar");
    expect(projectsViewSource).toContain('data-testid="sidebar-v2-chats-panel"');
    expect(projectsViewSource).toContain('className="bg-sidebar surface-grain pb-1"');
    expect(projectsViewSource).toContain('import "./ChatsDock.css"');
  });
});
