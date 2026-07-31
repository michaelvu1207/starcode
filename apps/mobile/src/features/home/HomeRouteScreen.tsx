import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const { archiveThread, confirmDeleteThread } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const listOptions = useHomeListOptions();
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectFilterOptions = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({
          projects,
          projectGroupingMode: listOptions.projectGroupingMode,
        }),
        threads,
        pendingTasks,
        projectSortOrder: "updated_at",
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, pendingTasks, projects, threads],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions options={{ title: "", headerTitle: "" }} />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          }
        />
        <WorkspaceEmptyDetail
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Restore the compact title in case the split branch blanked it. */}
        <NativeStackScreenOptions options={{ title: "Threads", headerTitle: "Threads" }} />
        <HomeHeader
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedProjectKey={selectedProjectKey}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />

        <HomeScreen
          catalogState={catalogState}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
          }
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
          }
          onSelectThread={(thread) => {
            navigation.navigate("Thread", {
              environmentId: thread.environmentId,
              threadId: thread.id,
            });
          }}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
