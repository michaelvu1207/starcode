import { describe, expect, it } from "vite-plus/test";

import {
  applyAllProjectsScopeGuard,
  isPersistedProjectScopeKey,
  purgePersistedProjectScope,
  type ProjectScopeStorage,
} from "./sidebarProjectScope";

function fakeStorage(entries: Record<string, string>): ProjectScopeStorage & {
  readonly entries: Record<string, string>;
} {
  const store = { ...entries };
  return {
    entries: store,
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

describe("isPersistedProjectScopeKey", () => {
  it.each([
    "starcode:sidebar-v2:project-scope",
    "sidebarV2ProjectScope",
    "SIDEBAR_PROJECT_SCOPE",
    "starcode:sidebar:projectScope:v1",
  ])("matches %s", (key) => {
    expect(isPersistedProjectScopeKey(key)).toBe(true);
  });

  it.each([
    "chat_thread_sidebar_width",
    "starcode:version-mismatch-dismissals:v1",
    "sidebar-collapsed-groups",
    "starcode:command-palette:project-scope",
  ])("leaves %s alone", (key) => {
    expect(isPersistedProjectScopeKey(key)).toBe(false);
  });
});

describe("purgePersistedProjectScope", () => {
  it("removes every persisted scope and nothing else", () => {
    const storage = fakeStorage({
      "starcode:sidebar-v2:project-scope": "env-1:proj-a",
      chat_thread_sidebar_width: "256",
      sidebarV2ProjectScope: "env-2:proj-b",
    });

    expect(purgePersistedProjectScope(storage)).toEqual([
      "starcode:sidebar-v2:project-scope",
      "sidebarV2ProjectScope",
    ]);
    expect(storage.entries).toEqual({ chat_thread_sidebar_width: "256" });
  });

  it("is a no-op without storage", () => {
    expect(purgePersistedProjectScope(null)).toEqual([]);
    expect(purgePersistedProjectScope(undefined)).toEqual([]);
  });
});

describe("applyAllProjectsScopeGuard", () => {
  it("resets an active filter to all-projects", () => {
    const result = applyAllProjectsScopeGuard({ projectScopeKey: "env-1:proj-a" });

    expect(result.nextScopeKey).toBeNull();
    expect(result.didReset).toBe(true);
  });

  it("drops a persisted filter so it cannot resurrect the hidden scope", () => {
    const storage = fakeStorage({ "starcode:sidebar-v2:project-scope": "env-1:proj-a" });

    const result = applyAllProjectsScopeGuard({ projectScopeKey: null, storage });

    expect(result.nextScopeKey).toBeNull();
    expect(result.didReset).toBe(true);
    expect(result.clearedStorageKeys).toEqual(["starcode:sidebar-v2:project-scope"]);
    expect(storage.entries).toEqual({});
  });

  it("reports no reset when the sidebar is already unfiltered", () => {
    const storage = fakeStorage({ chat_thread_sidebar_width: "256" });

    const result = applyAllProjectsScopeGuard({ projectScopeKey: null, storage });

    expect(result.nextScopeKey).toBeNull();
    expect(result.didReset).toBe(false);
    expect(result.clearedStorageKeys).toEqual([]);
  });
});
