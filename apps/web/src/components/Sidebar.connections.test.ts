import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarConnectionGroups,
  limitSidebarConnectionRows,
  resolveSidebarConnectionGroupExpanded,
  sidebarConnectionDotClassName,
  sidebarConnectionGroupExpansionKey,
  supportsSidebarRangeSelect,
  type SidebarConnectionRow,
} from "./Sidebar.connections";

const LOCAL = EnvironmentId.make("env-local");
const LAPTOP = EnvironmentId.make("env-laptop");
const SERVER = EnvironmentId.make("env-server");
const GONE = EnvironmentId.make("env-gone");

const CONNECTED: EnvironmentConnectionPresentation = {
  phase: "connected",
  error: null,
  traceId: null,
};
const OFFLINE: EnvironmentConnectionPresentation = { phase: "offline", error: null, traceId: null };

function makeThread(id: string, environmentId: EnvironmentId): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeRows(count: number, environmentId: EnvironmentId): SidebarConnectionRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    thread: makeThread(`thread-${index}`, environmentId),
    section: "active" as const,
  }));
}

const ENVIRONMENTS = [
  {
    environmentId: SERVER,
    label: "simforge1",
    serverLabel: "simforge1",
    isOwnBackend: false,
    connection: CONNECTED,
  },
  {
    environmentId: LOCAL,
    label: "This machine",
    serverLabel: "This machine",
    isOwnBackend: false,
    connection: CONNECTED,
  },
  {
    environmentId: LAPTOP,
    label: "laptop",
    serverLabel: "laptop",
    isOwnBackend: false,
    connection: OFFLINE,
  },
];

describe("buildSidebarConnectionGroups", () => {
  it("groups the inbox partition by machine, local connection first", () => {
    const groups = buildSidebarConnectionGroups({
      activeThreads: [makeThread("a", SERVER), makeThread("b", LOCAL)],
      snoozedThreads: [],
      settledThreads: [],
      environments: ENVIRONMENTS,
      primaryEnvironmentId: LOCAL,
    });

    expect(groups.map((group) => group.label)).toEqual(["This machine", "laptop", "simforge1"]);
    expect(groups[0]?.isLocal).toBe(true);
    expect(groups[0]?.rows.map((row) => row.thread.id)).toEqual(["b"]);
    expect(groups[2]?.rows.map((row) => row.thread.id)).toEqual(["a"]);
  });

  it("keeps a connected machine with no threads as an empty group", () => {
    const groups = buildSidebarConnectionGroups({
      activeThreads: [],
      snoozedThreads: [],
      settledThreads: [],
      environments: ENVIRONMENTS,
      primaryEnvironmentId: LOCAL,
    });

    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.rows.length === 0)).toBe(true);
  });

  it("preserves the partition's order inside a group and tags each row's section", () => {
    const groups = buildSidebarConnectionGroups({
      activeThreads: [makeThread("active-1", LOCAL), makeThread("active-2", LOCAL)],
      snoozedThreads: [makeThread("snoozed", LOCAL)],
      settledThreads: [makeThread("settled", LOCAL)],
      environments: ENVIRONMENTS,
      primaryEnvironmentId: LOCAL,
    });

    expect(groups[0]?.rows.map((row) => [row.thread.id, row.section])).toEqual([
      ["active-1", "active"],
      ["active-2", "active"],
      ["snoozed", "snoozed"],
      ["settled", "settled"],
    ]);
  });

  it("still renders threads whose environment left the catalog, sunk to the bottom", () => {
    const groups = buildSidebarConnectionGroups({
      activeThreads: [makeThread("orphan", GONE), makeThread("live", LOCAL)],
      snoozedThreads: [],
      settledThreads: [],
      environments: ENVIRONMENTS,
      primaryEnvironmentId: LOCAL,
    });

    const orphanGroup = groups.at(-1);
    expect(orphanGroup?.environmentId).toBe(GONE);
    expect(orphanGroup?.connection).toBeNull();
    expect(orphanGroup?.rows.map((row) => row.thread.id)).toEqual(["orphan"]);
    // The whole point: no thread is dropped on the floor.
    expect(groups.flatMap((group) => group.rows)).toHaveLength(2);
  });

  it("has no local group when nothing is primary yet", () => {
    const groups = buildSidebarConnectionGroups({
      activeThreads: [],
      snoozedThreads: [],
      settledThreads: [],
      environments: ENVIRONMENTS,
      primaryEnvironmentId: null,
    });

    // Nothing to pin to the top, so the whole list falls back to server-label order.
    expect(groups.some((group) => group.isLocal)).toBe(false);
    expect(groups.map((group) => group.label)).toEqual(["laptop", "simforge1", "This machine"]);
  });

  it("keeps a renamed group where it was, and carries the server label for the rename field", () => {
    // The pencil on this header writes an alias, so ordering by the displayed
    // name would slide the group away the moment the rename lands.
    const renamed = ENVIRONMENTS.map((environment) =>
      environment.environmentId === SERVER ? { ...environment, label: "aardvark" } : environment,
    );
    const groups = buildSidebarConnectionGroups({
      activeThreads: [],
      snoozedThreads: [],
      settledThreads: [],
      environments: renamed,
      primaryEnvironmentId: LOCAL,
    });

    expect(groups.map((group) => group.environmentId)).toEqual([LOCAL, LAPTOP, SERVER]);
    expect(groups.map((group) => group.label)).toEqual(["This machine", "laptop", "aardvark"]);
    // Clearing the field has to get back to the machine's own name.
    expect(groups.at(-1)?.serverLabel).toBe("simforge1");
  });
});

describe("limitSidebarConnectionRows", () => {
  it("pages a long group and reports what it hid", () => {
    const limited = limitSidebarConnectionRows(makeRows(30, LOCAL), 25, null);
    expect(limited.rows).toHaveLength(25);
    expect(limited.hiddenCount).toBe(5);
  });

  it("leaves a short group untouched", () => {
    const rows = makeRows(3, LOCAL);
    const limited = limitSidebarConnectionRows(rows, 25, null);
    expect(limited.rows).toBe(rows);
    expect(limited.hiddenCount).toBe(0);
  });

  it("pulls the open thread out of the hidden tail", () => {
    const limited = limitSidebarConnectionRows(makeRows(30, LOCAL), 25, `${LOCAL}:thread-29`);
    expect(limited.rows.at(-1)?.thread.id).toBe("thread-29");
    expect(limited.hiddenCount).toBe(4);
  });
});

describe("connection group presentation", () => {
  it("namespaces its collapse key and defaults to expanded", () => {
    const key = sidebarConnectionGroupExpansionKey(LAPTOP);
    expect(key).toBe("sidebar-connection-group:env-laptop");
    expect(resolveSidebarConnectionGroupExpanded({}, LAPTOP)).toBe(true);
    expect(resolveSidebarConnectionGroupExpanded({ [key]: false }, LAPTOP)).toBe(false);
    // A collapsed project must not collapse a machine that happens to share a name.
    expect(resolveSidebarConnectionGroupExpanded({ "env-laptop": false }, LAPTOP)).toBe(true);
  });

  it("allows range-select only where the rendered order defines the range", () => {
    expect(supportsSidebarRangeSelect("inbox")).toBe(true);
    // Grouped rows are not in orderedThreadKeys order, so a range there would
    // sweep in threads that are not on screen — and bulk actions would run on
    // them.
    expect(supportsSidebarRangeSelect("connections")).toBe(false);
  });

  it("colours the dot the way the connections settings rows do", () => {
    expect(sidebarConnectionDotClassName(CONNECTED)).toBe("bg-success");
    expect(sidebarConnectionDotClassName({ ...CONNECTED, phase: "reconnecting" })).toBe(
      "bg-warning",
    );
    expect(sidebarConnectionDotClassName({ ...CONNECTED, phase: "error" })).toBe("bg-destructive");
    expect(sidebarConnectionDotClassName(OFFLINE)).toBe("bg-muted-foreground/40");
    expect(sidebarConnectionDotClassName(null)).toBe("bg-muted-foreground/40");
  });
});
