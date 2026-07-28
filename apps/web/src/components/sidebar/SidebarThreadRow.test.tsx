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
    driverKind: null,
    providerDisplayName: "Codex",
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

  it("holds still under the pointer — only the time gives way to the archive button", () => {
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
    expect(markup).toContain('data-testid="sidebar-v2-row-archive"');
  });

  it("carries one verb, and it is archive", () => {
    const markup = render();

    // The `···` is gone, and so is the hover strip that preceded it. Everything
    // they held is on the row's context menu now.
    expect(markup).not.toContain('data-testid="sidebar-v2-row-menu"');
    expect(markup).not.toContain('aria-label="Thread actions"');
    expect(markup).not.toContain('aria-label="Settle thread"');
    expect(markup).not.toContain('aria-label="Snooze thread"');
    expect(markup).toContain('aria-label="Archive thread"');
  });

  it("shows the archive button on every row, whatever the server supports", () => {
    // The row takes no capability props any more, and that is the point:
    // archive asks the server nothing, so there is no server old enough — and
    // no section — that leaves the hover slot empty. This used to be a real
    // state, with a capability-gated menu wearing an empty `···`.
    for (const rowAction of ["settle", "unsettle", "unsnooze"] as const) {
      const markup = render({ rowAction, snoozeWakeLabelText: "2h" });
      expect(markup).toContain('data-testid="sidebar-v2-row-archive"');
      // And the time makes way for it, on every row, for the same reason.
      expect(markup).toContain("group-hover/v2-row:opacity-0");
    }
  });

  it("stops the archive click from reaching the row underneath it", () => {
    // Without this the one click both archives the thread and navigates to it —
    // opening the thread it just took off the list. The row is a click target
    // all the way across, so every control on it has to stop its own event.
    const at = rowSource.indexOf('data-testid="sidebar-v2-row-archive"');
    expect(at).toBeGreaterThan(-1);
    expect(rowSource.slice(at, at + 400)).toContain("event.stopPropagation()");
  });

  it("keeps archive reachable from the keyboard, not hover alone", () => {
    // The row is tabbable and this is the next stop after it. A hover-only
    // control is a control a keyboard never reaches, and archive is now the
    // row's only one.
    expect(render()).toContain("focus-within:opacity-100");
  });

  it("hands the whole rest of the menu to right-click", () => {
    // The row's context-menu handler is the single way in to rename, move,
    // fork, settle, snooze, mark-unread, split, archive and delete. Asserted
    // here because the row is where the gesture is bound; what the menu
    // contains is SidebarV2's business.
    expect(rowSource).toContain("onContextMenu={actions.onContextMenu}");
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
