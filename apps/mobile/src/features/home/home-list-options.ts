import type { SidebarProjectGroupingMode } from "@starcode/contracts";
import { createContext, createElement, useContext, useMemo, type PropsWithChildren } from "react";

export interface HomeListOptions {
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

export function resolveProjectGroupingMode(
  projectGroupingEnabled: boolean | undefined,
): SidebarProjectGroupingMode {
  return projectGroupingEnabled === false ? "separate" : "repository";
}

const HomeListOptionsContext = createContext<HomeListOptions | null>(null);

/** Keeps project grouping stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
}: PropsWithChildren<{ readonly projectGroupingMode: SidebarProjectGroupingMode }>) {
  const value = useMemo(() => ({ projectGroupingMode }), [projectGroupingMode]);
  return createElement(HomeListOptionsContext, { value }, children);
}

export function useHomeListOptions(): HomeListOptions {
  return useContext(HomeListOptionsContext) ?? { projectGroupingMode: "repository" };
}
