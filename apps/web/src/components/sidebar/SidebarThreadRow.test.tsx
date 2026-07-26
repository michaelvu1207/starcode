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
  onSettle: noop,
  onUnsettle: noop,
  onUnsnooze: noop,
  onSnooze: noop,
  onSnoozeMenuOpenChange: noop,
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
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
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
  return renderToStaticMarkup(
    SidebarThreadRow({
      thread: makeThread(threadOverrides),
      status: "ready",
      flags: {
        isActive: false,
        isSelected: false,
        isUnread: false,
        isWoke: false,
        shouldRecede: false,
        isRenaming: false,
        snoozeMenuOpen: false,
      },
      actions,
      timeLabel: "4h",
      snoozeWakeLabelText: null,
      rowAction: "settle",
      settlementSupported: true,
      snoozeSupported: true,
      showSnoozeButton: true,
      driverKind: null,
      providerDisplayName: "Codex",
      jumpLabel: null,
      renamingTitle: "",
      tooltip: null,
      ...overrides,
    }) as never,
  );
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

  it("carries the name, the machine and the time on one row", () => {
    const markup = render();

    expect(markup).toContain('data-testid="sidebar-v2-row"');
    expect(markup).toContain("Teach the sidebar one row");
    expect(markup).toContain('data-environment-id="env-laptop"');
    expect(markup).toContain(">4h<");
  });

  it("is one shape for every section — settled and snoozed rows are the same row", () => {
    // The variant split is the thing this component replaced: a thread that
    // settles must not change size or lose its machine and its agent.
    const live = render({ rowAction: "settle" });
    const settled = render({ rowAction: "unsettle" });
    const snoozed = render({ rowAction: "unsnooze", snoozeWakeLabelText: "2h" });

    for (const markup of [live, settled, snoozed]) {
      expect(markup).toContain('data-testid="sidebar-v2-row"');
      expect(markup).toContain('data-environment-id="env-laptop"');
      // The old shapes are gone, not merely unused.
      expect(markup).not.toContain("sidebar-v2-row-card");
      expect(markup).not.toContain("sidebar-v2-row-slim");
    }
    // A snoozed row shows when it comes back, not when it last spoke.
    expect(snoozed).toContain(">2h<");
    expect(snoozed).not.toContain(">4h<");
  });

  it("draws no card: the row surface is square and full-bleed", () => {
    const markup = render();
    const surface = markup.slice(markup.indexOf('data-testid="sidebar-v2-row"'));
    const classes = surface.slice(surface.indexOf('class="'), surface.indexOf('">'));

    expect(classes).not.toContain("rounded");
    expect(classes).toContain("h-8");
  });

  it("shows which agent is driving the thread, when one is known", () => {
    // The glyph is decorative markup with no text of its own, so the row's own
    // wrapper is what a caller can assert on — and what the driver kind lands
    // in when Claude and Codex threads sit in the same list.
    expect(render({ driverKind: ProviderDriverKind.make("codex") })).toContain(
      'data-driver-kind="codex"',
    );
    expect(render({ driverKind: ProviderDriverKind.make("claude") })).toContain(
      'data-driver-kind="claude"',
    );
    expect(render({ driverKind: null })).not.toContain('data-testid="sidebar-v2-row-provider"');
  });

  it("names the live status for anyone who cannot see the colour", () => {
    expect(render({ status: "working" })).toContain('aria-label="Working"');
    expect(render({ status: "approval" })).toContain('aria-label="Waiting for approval"');
    // A quiet, read thread wears no badge at all.
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
  isWoke: false,
  shouldRecede: false,
  isRenaming: false,
  snoozeMenuOpen: false,
};
