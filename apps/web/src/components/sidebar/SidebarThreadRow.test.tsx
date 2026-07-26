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
  const props = {
    thread: makeThread(threadOverrides),
    status: "ready",
    flags: {
      isActive: false,
      isSelected: false,
      isUnread: false,
      isWoke: false,
      shouldRecede: false,
      isRenaming: false,
    },
    actions,
    timeLabel: "4h",
    snoozeWakeLabelText: null,
    rowAction: "settle",
    settlementSupported: true,
    snoozeSupported: true,
    snoozeAllowed: true,
    driverKind: null,
    providerDisplayName: "Codex",
    jumpLabel: null,
    renamingTitle: "",
    tooltip: null,
    // Off by default: whether a split can hold this thread is a property of the
    // window, and letting it default to true would let every assertion about
    // settlement and snooze pass for the wrong reason.
    canOpenInSplit: false,
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

  it("holds still under the pointer — only the time gives way to the menu", () => {
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

  it("puts the row's actions behind the menu rather than on the row", () => {
    const markup = render();

    // The old hover strip's buttons are gone from the row itself; what they did
    // now lives in the menu, which SSR does not open.
    expect(markup).not.toContain('aria-label="Settle thread"');
    expect(markup).not.toContain('aria-label="Snooze thread"');
    expect(markup).toContain('aria-label="Thread actions"');
  });

  it("shows no menu button when the row has nothing to offer", () => {
    // An empty ··· is a lie, and on a server that predates settlement every
    // row would have worn one.
    const markup = render({
      settlementSupported: false,
      snoozeAllowed: false,
      snoozeSupported: false,
    });

    expect(markup).not.toContain('data-testid="sidebar-v2-row-menu"');
    // The time then never fades, because nothing is coming to replace it.
    expect(markup).not.toContain("group-hover/v2-row:opacity-0");
  });

  it("earns the menu on the split alone, where the row has no other action", () => {
    // The split entry is the only thing in this menu that opens something
    // rather than filing it away, so it has to be able to put the `···` there
    // by itself — on a server too old for settlement, on a row that cannot be
    // snoozed, on any row at all. Whether it *may* is decided upstream; all the
    // row does is count it as an action.
    const noOtherActions = {
      settlementSupported: false,
      snoozeAllowed: false,
      snoozeSupported: false,
    };

    expect(render({ ...noOtherActions, canOpenInSplit: true })).toContain(
      'data-testid="sidebar-v2-row-menu"',
    );
    expect(render({ ...noOtherActions, canOpenInSplit: false })).not.toContain(
      'data-testid="sidebar-v2-row-menu"',
    );
  });

  it("offers the menu on a snoozed row only where waking is supported", () => {
    expect(
      render({ rowAction: "unsnooze", snoozeWakeLabelText: "2h", snoozeSupported: true }),
    ).toContain('data-testid="sidebar-v2-row-menu"');
    expect(
      render({
        rowAction: "unsnooze",
        snoozeWakeLabelText: "2h",
        snoozeSupported: false,
        snoozeAllowed: false,
      }),
    ).not.toContain('data-testid="sidebar-v2-row-menu"');
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
};
