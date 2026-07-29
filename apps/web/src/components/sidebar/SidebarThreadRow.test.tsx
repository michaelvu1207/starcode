import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadPlanSummary,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import rowSource from "./SidebarThreadRow.tsx?raw";
import { SidebarThreadRow, type SidebarThreadRowActions } from "./SidebarThreadRow";

const noop = () => {};
const actions: SidebarThreadRowActions = {
  onClick: noop,
  onDoubleClick: noop,
  onKeyDown: noop,
  onContextMenu: noop,
  onRenameChange: noop,
  onRenameKeyDown: noop,
  onRenameBlur: noop,
  onStartRename: noop,
  onArchive: noop,
};

function makeThread(overrides?: Partial<EnvironmentThreadShell>): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("env-laptop"),
    id: ThreadId.make("t-1"),
    projectId: ProjectId.make("project-1"),
    title: "Teach the sidebar one row",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function render(
  overrides?: Partial<Parameters<typeof SidebarThreadRow>[0]>,
  threadOverrides?: Partial<EnvironmentThreadShell>,
): string {
  const props = {
    thread: makeThread(threadOverrides),
    status: "ready",
    flags: {
      isActive: false,
      isSelected: false,
      isUnread: false,
      shouldRecede: false,
      isRenaming: false,
    },
    actions,
    timeLabel: "4h",
    driverKind: null,
    jumpLabel: null,
    renamingTitle: "",
    tooltip: null,
    // Hidden by default: whether a split can hold this thread is a property of
    // the window and of what is already on screen.
    splitState: "hidden",
    onOpenInSplit: noop,
    ...overrides,
  } as Parameters<typeof SidebarThreadRow>[0];
  return renderToStaticMarkup(<SidebarThreadRow {...props} />);
}

describe("SidebarThreadRow", () => {
  const globals = globalThis as { window?: unknown };
  let previousWindow: unknown;

  beforeEach(() => {
    previousWindow = globals.window;
    globals.window = new EventTarget();
  });

  afterEach(() => {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  });

  it("carries the name and the time on one row", () => {
    const markup = render();

    expect(markup).toContain('data-testid="sidebar-v2-row"');
    expect(markup).toContain("Teach the sidebar one row");
    expect(markup).toContain(">4h<");
    // The old shapes are gone, not merely unused.
    expect(markup).not.toContain("sidebar-v2-row-card");
    expect(markup).not.toContain("sidebar-v2-row-slim");
  });

  it("draws no card: the row surface is square and full-bleed", () => {
    const markup = render();
    const surface = markup.slice(markup.indexOf('data-testid="sidebar-v2-row"'));
    const classes = surface.slice(surface.indexOf('class="'), surface.indexOf('">'));

    expect(classes).not.toContain("rounded");
    expect(classes).toContain("h-8");
  });

  it("draws no agent glyph — which of Claude or Codex is driving is tooltip detail", () => {
    // Asserted for a known driver rather than only for `null`: the row still
    // takes `driverKind`, because the menu forks a session with it, so "the
    // prop is absent" and "the glyph is absent" are different claims and it is
    // the second one that survives a later change.
    for (const driverKind of [
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claude"),
      null,
    ]) {
      const markup = render({ driverKind });
      expect(markup).not.toContain('data-testid="sidebar-v2-row-provider"');
      expect(markup).not.toContain("data-driver-kind");
    }
  });

  it("draws the machine as the status glyph's colour rather than a mark of its own", () => {
    const markup = render({ status: "working" });
    const status = markup.slice(markup.indexOf('data-testid="sidebar-v2-row-status"'));

    // The mark that used to lead the row is gone: two glyphs on a 32px row is
    // one more than carries its weight.
    expect(markup).not.toContain('data-testid="connection-mark"');
    // What replaced it: the same machine hue, on the glyph that was already
    // there. Same class the connection groups draw, so one machine is one
    // colour everywhere.
    expect(status).toContain("sc-machine-mark");
    expect(status).toContain("--sc-machine-hue");
    expect(status).toContain('data-environment-id="env-laptop"');
  });

  it("names the live status for anyone who cannot see the colour", () => {
    expect(render({ status: "working" })).toContain('aria-label="Working"');
    expect(render({ status: "approval" })).toContain('aria-label="Waiting for approval"');
    // A quiet, read thread wears no badge at all — and so shows no machine
    // either, which is the trade the colour-carries-the-machine design makes.
    expect(render()).not.toContain('data-testid="sidebar-v2-row-status"');
  });

  it("draws the task list along the row rather than on a line of its own", () => {
    const planSummary = {
      total: 4,
      completed: 2,
      activeStep: "Wire the row",
    } as unknown as OrchestrationThreadPlanSummary;

    expect(render(undefined, { planSummary })).toContain('role="progressbar"');
    expect(render()).not.toContain('role="progressbar"');
  });

  it("holds still under the pointer — only the time gives way to the actions", () => {
    // The regression this guards: hover used to fade out the machine, the
    // agent and the status alongside the time and slide a strip of icon
    // buttons in over them. Four things moved every time the pointer crossed a
    // row, which in a list you skim is most of the time.
    const markup = render();
    const hoverFades = markup.match(/group-hover\/v2-row:opacity-0/g) ?? [];

    expect(hoverFades).toHaveLength(1);
    // …and the one that does fade is the time, so the icons keep their place.
    const timeSlot = markup.slice(markup.lastIndexOf("group-hover/v2-row:opacity-0"));
    expect(timeSlot).toContain("4h");
    expect(markup).toContain('data-testid="sidebar-v2-row-menu"');
  });

  it("puts archive on the row itself, one click from the pointer", () => {
    const markup = render();

    // Archive is the one thing you do to a thread you are finished with, so it
    // does not wait behind the `···` — it sits beside it in the same hover
    // strip. (The menu keeps its own copy, which SSR does not open.)
    expect(markup).toContain('data-testid="sidebar-v2-row-archive"');
    expect(markup).toContain('aria-label="Archive thread"');
    expect(markup).toContain('aria-label="Thread actions"');
  });

  it("gives the hover strip the row's own background so it does not float over the title", () => {
    // It is wider than the time it replaces, so without a backing it would sit
    // on top of the tail of a long title.
    const markup = render();
    const strip = markup.slice(markup.indexOf("focus-within:opacity-100"));

    expect(strip).toContain("bg-sidebar-row-hover");
  });

  it("offers the same menu on every row", () => {
    // This used to be capability-gated: when every entry in the menu depended
    // on a server capability, an older server left rows wearing an empty
    // `···`. Rename, move, fork and archive ask the server for nothing, so the
    // menu always has entries.
    const markup = render();

    expect(markup).toContain('data-testid="sidebar-v2-row-menu"');
    // And the time makes way for it, on every row, for the same reason.
    expect(markup).toContain("group-hover/v2-row:opacity-0");
  });

  it("mounts the thread verbs only while the popup is open", () => {
    // They carry hooks — the project catalog, the thread commands, the router —
    // and this component is rendered once per thread in a list that runs to
    // hundreds. Gating on `open` is what keeps one row's menu from charging
    // every other row for it. Source-level: SSR never opens a base-ui popup, so
    // a render cannot tell the two apart.
    //
    // Asserted as "each mount sits inside an `open ?` guard" rather than as one
    // exact line, because the formatter reflows these across lines the moment a
    // prop is added — and a discriminator that breaks on reformatting is a
    // discriminator that gets deleted rather than fixed.
    const at = rowSource.indexOf("<ThreadRowFilingActions");
    expect(at).toBeGreaterThan(-1);
    expect(rowSource.slice(Math.max(0, at - 60), at)).toContain("{open ? ");
  });

  it("puts archive last, alone, below its own separator", () => {
    // Ordering is the whole safety story for this entry: it is the only one in
    // the menu that takes the thread off the list.
    const archiveAt = rowSource.indexOf("<ThreadRowArchiveAction");
    const filingAt = rowSource.indexOf("<ThreadRowFilingActions");

    expect(filingAt).toBeLessThan(archiveAt);
    expect(rowSource.slice(0, archiveAt).lastIndexOf("<MenuSeparator />")).toBeGreaterThan(
      filingAt,
    );
  });

  it("routes the row button and the menu entry at one archive handler", () => {
    // Two ways in, one act. Two implementations would eventually disagree
    // about what archiving does.
    expect(rowSource).toContain("onClick={actions.onArchive}");
    expect(rowSource).toContain("onArchive={actions.onArchive}");
  });

  it("greys the split entry out rather than letting it look clickable", () => {
    // Checked against the source: a base-ui menu only mounts its items once it
    // is open, and SSR never opens one, so the rendered markup of every case
    // above is identical inside the popup. This is the one property of the
    // entry that a render cannot see, and "disabled" is half of what makes an
    // already-open thread explain itself instead of appearing to do nothing.
    expect(rowSource).toContain('disabled={splitState !== "ready"}');
    // Belt and braces, because the two say different things: the first makes it
    // *look* inert, the second makes it *be* inert.
    expect(rowSource).toContain('if (splitState === "ready") onOpenInSplit();');
  });

  it("stops the split click from reaching the row underneath it", () => {
    // Found in a browser, not here: the menu popup is portalled to the body,
    // but a React portal's events bubble up the *component* tree, so a click on
    // this item also fires the row's own handler — and the row navigates. The
    // symptom was that opening a thread on the right dragged the left pane onto
    // it too, which is precisely what this entry exists not to do.
    //
    // Source-level for the same reason as above: SSR never opens the popup, so
    // there is no item to dispatch a click at.
    const splitItem = rowSource.slice(
      rowSource.indexOf("SPLIT_MENU_LABEL[splitState]") - 900,
      rowSource.indexOf("SPLIT_MENU_LABEL[splitState]"),
    );
    expect(splitItem).toContain("event.stopPropagation()");
  });

  it("routes the menu's Rename at the same handler double-click uses", () => {
    // Two ways in, one act: the rename input is row state, so the entry cannot
    // own it and must call back out. Source-level — the entry lives inside the
    // popup, which SSR never opens.
    expect(rowSource).toContain("onRename={actions.onStartRename}");
  });

  it("swaps the title for an input while renaming", () => {
    const markup = render({
      flags: { ...renderFlags, isRenaming: true },
      renamingTitle: "New name",
    });

    expect(markup).toContain('aria-label="Thread title"');
    expect(markup).toContain('value="New name"');
  });
});

const renderFlags = {
  isActive: false,
  isSelected: false,
  isUnread: false,
  shouldRecede: false,
  isRenaming: false,
};
