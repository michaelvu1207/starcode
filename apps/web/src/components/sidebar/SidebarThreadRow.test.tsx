import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadPlanSummary,
} from "@starcode/contracts";
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
    jumpLabel: null,
    renamingTitle: "",
    tooltip: null,
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
    const markup = render();

    expect(markup).not.toContain('data-testid="sidebar-v2-row-provider"');
    expect(markup).not.toContain("data-driver-kind");
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

  it("places the live status before the thread title", () => {
    const markup = render({ status: "working" });

    expect(markup.indexOf('data-testid="sidebar-v2-row-status"')).toBeLessThan(
      markup.indexOf("Teach the sidebar one row"),
    );
  });

  it("draws task progress only while the thread is actively working", () => {
    const planSummary = {
      total: 4,
      completed: 2,
      activeStep: "Wire the row",
    } as unknown as OrchestrationThreadPlanSummary;

    expect(render({ status: "working" }, { planSummary })).toContain('role="progressbar"');
    for (const status of ["ready", "approval", "input", "agents", "failed"] as const) {
      expect(render({ status }, { planSummary })).not.toContain('role="progressbar"');
    }
    expect(render({ status: "working" })).not.toContain('role="progressbar"');
  });

  it("holds still under the pointer — only the time gives way to the actions", () => {
    // The regression this guards: hover used to fade out the machine, the
    // agent and the status alongside the time and slide a strip of icon
    // buttons in over them. Four things moved every time the pointer crossed a
    // row, which in a list you skim is most of the time.
    const markup = render();
    const hoverFades = markup.match(/group-hover\/v2-row:opacity-0/g) ?? [];

    expect(hoverFades).toHaveLength(1);
    // …and the one that does fade is the time, so the archive button can take
    // its place without moving the status or title.
    const timeSlot = markup.slice(markup.lastIndexOf("group-hover/v2-row:opacity-0"));
    expect(timeSlot).toContain("4h");
  });

  it("puts archive on the row itself, one click from the pointer", () => {
    const markup = render();

    // Archive remains the one thing you do to a thread you are finished with
    // often enough to deserve a direct pointer and keyboard target.
    expect(markup).toContain('data-testid="sidebar-v2-row-archive"');
    expect(markup).toContain('aria-label="Archive thread"');
  });

  it("gives the hover strip the row's own background so it does not float over the title", () => {
    // It is wider than the time it replaces, so without a backing it would sit
    // on top of the tail of a long title.
    const markup = render();
    const strip = markup.slice(markup.indexOf("focus-within:opacity-100"));

    expect(strip).toContain("bg-sidebar-row-hover");
  });

  it("does not render a visible overflow control", () => {
    const markup = render();

    expect(markup).not.toContain('data-testid="sidebar-v2-row-menu"');
    expect(markup).not.toContain('aria-label="Thread actions"');
    expect(rowSource).toContain("onContextMenu={actions.onContextMenu}");
  });

  it("routes the direct archive control through the row action handler", () => {
    expect(rowSource).toContain("onClick={actions.onArchive}");
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
