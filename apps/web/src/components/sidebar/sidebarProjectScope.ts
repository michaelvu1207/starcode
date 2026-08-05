/**
 * Correctness guard for the compact sidebar header.
 *
 * The compact header drops the "All projects" picker, which was the only
 * affordance for changing or clearing the sidebar's project filter. The filter
 * itself still exists downstream — `scopedProjectKeys` feeds
 * `partitionSidebarV2Threads`, so a non-null scope hides every thread outside
 * that project. With no picker, an active scope would hide threads with no way
 * to unhide them.
 *
 * So: every mount starts at all-projects, and anything persisted that could
 * restore a scope is dropped. Today the scope is component state only (nothing
 * writes it to storage), which makes the purge a guard against a future or
 * previously-shipped persistence layer rather than a migration of live data.
 */
import { useEffect } from "react";

/** The scope value that means "show every project". */
export const ALL_PROJECTS_SCOPE_KEY = null;

/** The `Storage` surface the purge needs — narrowed so tests can fake it. */
export interface ProjectScopeStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/**
 * True for storage keys that could hold a sidebar project scope. Matching is
 * done on letters only so separators and casing (`sidebar-v2:project-scope`,
 * `sidebarV2ProjectScope`, `SIDEBAR_PROJECT_SCOPE`) all resolve the same.
 */
export function isPersistedProjectScopeKey(key: string): boolean {
  const letters = key.toLowerCase().replace(/[^a-z]/g, "");
  return letters.includes("sidebar") && letters.includes("projectscope");
}

/** Removes every persisted project scope from `storage`; returns what it removed. */
export function purgePersistedProjectScope(
  storage: ProjectScopeStorage | null | undefined,
): readonly string[] {
  if (!storage) return [];
  const matched: Array<string> = [];
  // Collected before removing: removing during the walk reindexes the store.
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && isPersistedProjectScopeKey(key)) matched.push(key);
  }
  for (const key of matched) storage.removeItem(key);
  return matched;
}

export interface AllProjectsScopeGuardResult {
  /** The scope the sidebar must adopt — always all-projects. */
  readonly nextScopeKey: null;
  /** True when the guard actually had to clear something. */
  readonly didReset: boolean;
  readonly clearedStorageKeys: readonly string[];
}

/**
 * Resolves the scope a mounting sidebar must adopt and clears any persisted
 * scope behind it. Pure apart from the storage writes, so the whole guard is
 * testable without a DOM.
 */
export function applyAllProjectsScopeGuard(input: {
  readonly projectScopeKey: string | null;
  readonly storage?: ProjectScopeStorage | null;
}): AllProjectsScopeGuardResult {
  const clearedStorageKeys = purgePersistedProjectScope(input.storage);
  return {
    nextScopeKey: ALL_PROJECTS_SCOPE_KEY,
    didReset: input.projectScopeKey !== ALL_PROJECTS_SCOPE_KEY || clearedStorageKeys.length > 0,
    clearedStorageKeys,
  };
}

/**
 * Mount-time half of the guard: forces the sidebar back to all-projects and
 * purges persisted scopes. Runs once — later scope changes come from the
 * filter's own (now UI-less) callers.
 */
export function useAllProjectsScopeGuard(
  setProjectScopeKey: (scopeKey: string | null) => void,
): void {
  useEffect(() => {
    const { nextScopeKey } = applyAllProjectsScopeGuard({
      projectScopeKey: null,
      storage: typeof window === "undefined" ? null : window.localStorage,
    });
    setProjectScopeKey(nextScopeKey);
    // `setProjectScopeKey` is a `useState` setter, so this effect is
    // mount-only: re-running would fight any programmatic scoping.
  }, [setProjectScopeKey]);
}
