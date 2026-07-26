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
    // Hidden by default: whether a split can hold this thread is a property of
    // the window and of what is already on screen, and letting it default to
    // ready would let every assertion about settlement and snooze pass for the
    // wrong reason.
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
    // This used to be a real state: when every entry in the menu was
    // capability-gated, a server that predated settlement left rows wearing an
    // empty `···`. It cannot happen any more. Rename, move, fork and archive
    // ask the server for nothing, so the menu always has entries and the guard
    // that hid the button is gone — asserted here rather than deleted, because
    // "the oldest server still gets a usable row menu" is the property that
    // replaced it.
    const markup = render({
      settlementSupported: false,
      snoozeAllowed: false,
      snoozeSupported: false,
    });

    expect(markup).toContain('data-testid="sidebar-v2-row-menu"');
    // And the time makes way for it, on every row, for the same reason.
    expect(markup).toContain("group-hover/v2-row:opacity-0");
  });

  it("keeps the lifecycle entries capability-gated even though the menu is not", () => {
    // The menu is unconditional now; its *contents* are not. Settle, un-settle
    // and wake are still the entries a pre-settlement server has no verb for,
    // and the separator above them still has to disappear with them or the menu
    // grows a rule with nothing under it.
    expect(rowSource).toContain(
      'rowAction === "unsnooze" ? snoozeSupported : settlementSupported || snoozeAllowed',
    );
    expect(rowSource).toContain("{hasLifecycleEntries ? <MenuSeparator /> : null}");
  });

  it("mounts the thread verbs only while the popup is open", () => {
    // They carry hooks — the project catalog, the thread commands, the router —
    // and this component is rendered once per thread in a list that runs to
    // hundreds. Gating on `open` is what keeps one row's menu from charging
    // every other row for it. Source-level: SSR never opens a base-ui popup, so
    // a render cannot tell the two apart.
    expect(rowSource).toContain(
      "{open ? <ThreadRowFilingActions thread={thread} onRename={onRename} /> : null}",
    );
    expect(rowSource).toContain("{open ? <ThreadRowArchiveAction thread={thread} /> : null}");
  });

  it("puts archive last, alone, below its own separator", () => {
    // Ordering is the whole safety story for this entry: it is the only one
    // that takes the thread off the list, and it sits directly under the snooze
    // presets, which are what a fast hand is actually aiming for.
    const archiveAt = rowSource.indexOf("<ThreadRowArchiveAction");
    const filingAt = rowSource.indexOf("<ThreadRowFilingActions");
    const snoozeAt = rowSource.indexOf("resolveSnoozePresets(new Date())");

    expect(filingAt).toBeLessThan(archiveAt);
    expect(snoozeAt).toBeLessThan(archiveAt);
    expect(rowSource.slice(0, archiveAt).lastIndexOf("<MenuSeparator />")).toBeGreaterThan(
      filingAt,
    );
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

  it("offers the menu on a snoozed row whether or not waking is supported", () => {
    // A snoozed row on a server that cannot wake it still renames, moves, forks
    // and archives — the wake entry is the only one that goes missing.
    for (const snoozeSupported of [true, false]) {
      expect(
        render({
          rowAction: "unsnooze",
          snoozeWakeLabelText: "2h",
          snoozeSupported,
          snoozeAllowed: snoozeSupported,
        }),
      ).toContain('data-testid="sidebar-v2-row-menu"');
    }
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
  isWoke: false,
  shouldRecede: false,
  isRenaming: false,
};
