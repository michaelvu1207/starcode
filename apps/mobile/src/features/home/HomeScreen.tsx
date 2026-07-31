import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@starcode/client-runtime/state/shell";
import type { SidebarProjectGroupingMode } from "@starcode/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useRef } from "react";
import { ActivityIndicator, FlatList, Platform, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import type { SavedRemoteConnection } from "../../lib/connection";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useThemeColor } from "../../lib/useThemeColor";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { WorkspaceState } from "../../state/workspaceModel";
import { PendingTaskListRow } from "../threads/thread-list-items";
import { ThreadListV2AgentRow, ThreadListV2Row } from "../threads/thread-list-v2-items";
import { buildThreadListV2Items, type ThreadListV2Item } from "../threads/threadListV2";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "./homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { shouldShowWorkspaceConnectionStatus } from "./workspace-connection-status";
import { WorkspaceConnectionStatus } from "./WorkspaceConnectionStatus";

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly searchQuery: string;
  readonly selectedProjectKey: string | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onAddConnection: () => void;
  readonly onOpenEnvironments: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading machines",
      detail: "Checking the StarCode fleet connected to this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No machines connected",
      detail: "Add one StarCode machine to discover projects and threads across its fleet.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Fleet unavailable",
      detail:
        catalogState.connectionError ??
        "The connected machine is offline. Check the connection, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to fleet",
      detail: "Loading projects and threads from connected machines.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "No machine in the connected fleet reported a project.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task in any fleet project to start a coding session.",
    loading: false,
  };
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

export function HomeScreen(props: HomeScreenProps) {
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const accentColor = useThemeColor("--color-icon-muted");
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);

  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  // The catalog always starts with every project from every connected machine.
  // A logical project may have physical copies on several machines, and
  // selecting it keeps every copy visible.
  const projectScopes = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({
          projects: props.projects,
          projectGroupingMode: props.projectGroupingMode,
        }),
        threads: props.threads,
        pendingTasks: props.pendingTasks,
        projectSortOrder: "updated_at",
      }),
    [props.pendingTasks, props.projectGroupingMode, props.projects, props.threads],
  );
  const selectedProjectScope = useMemo(
    () =>
      props.selectedProjectKey === null
        ? null
        : (projectScopes.find(
            (scope) =>
              scope.key === props.selectedProjectKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  props.selectedProjectKey,
              ),
          ) ?? null),
    [projectScopes, props.selectedProjectKey],
  );
  const selectedProjectKeys = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  );
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);
  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [props.projects]);

  const threadListLayout = useMemo(
    () =>
      buildThreadListV2Items({
        threads: props.threads.filter((thread) => thread.archivedAt === null),
        projectRefs: selectedProjectScope?.projectRefs ?? null,
        searchQuery: props.searchQuery,
      }),
    [props.searchQuery, props.threads, selectedProjectScope],
  );
  const threadListItems = threadListLayout.items;
  const searchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const pendingTasks = props.pendingTasks.filter(
    (pendingTask) =>
      (selectedProjectKeys === null ||
        selectedProjectKeys.has(
          scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
        )) &&
      (searchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(searchQuery)),
  );

  // Mobile currently opens the owning thread for a child agent. The child row
  // still gives fleet-wide awareness that work continues after the parent
  // turn becomes quiet.
  const handleSelectAgent = useCallback(
    (thread: EnvironmentThreadShell, _taskId: string) => {
      props.onSelectThread(thread);
    },
    [props.onSelectThread],
  );
  const renderItem = useCallback(
    ({ item }: { readonly item: ThreadListV2Item }) =>
      item.kind === "agent" ? (
        <ThreadListV2AgentRow
          agent={item.agent}
          thread={item.thread}
          onSelectAgent={handleSelectAgent}
        />
      ) : (
        <ThreadListV2Row
          thread={item.thread}
          project={
            projectByKey.get(scopedProjectKey(item.thread.environmentId, item.thread.projectId)) ??
            null
          }
          projectTitle={projectTitleByProjectKey.get(
            scopedProjectKey(item.thread.environmentId, item.thread.projectId),
          )}
          providerDriver={
            serverConfigs
              .get(item.thread.environmentId)
              ?.providers.find(
                (provider) =>
                  provider.instanceId ===
                  (item.thread.session?.providerInstanceId ??
                    item.thread.modelSelection.instanceId),
              )?.driver ?? null
          }
          environmentLabel={
            Object.keys(props.savedConnectionsById).length > 1
              ? (props.savedConnectionsById[item.thread.environmentId]?.environmentLabel ?? null)
              : null
          }
          onSelectThread={props.onSelectThread}
          onDeleteThread={props.onDeleteThread}
          onArchiveThread={props.onArchiveThread}
          projectCwd={
            projectCwdByKey.get(
              scopedProjectKey(item.thread.environmentId, item.thread.projectId),
            ) ?? null
          }
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
        />
      ),
    [
      handleSelectAgent,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey,
      props.onArchiveThread,
      props.onDeleteThread,
      props.onSelectThread,
      props.savedConnectionsById,
      serverConfigs,
    ],
  );
  const keyExtractor = useCallback(
    (item: ThreadListV2Item) =>
      item.kind === "agent"
        ? `${item.thread.environmentId}:${item.thread.id}:agent:${item.agent.taskId}`
        : `${item.thread.environmentId}:${item.thread.id}`,
    [],
  );

  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const shouldShowConnectionStatus = shouldShowWorkspaceConnectionStatus(props.catalogState);
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });
  const connectionStatus =
    shouldShowConnectionStatus && Platform.OS !== "ios" ? (
      <View
        className="absolute left-0 right-0 items-center"
        style={{ bottom: Math.max(insets.bottom, 18) + 76 }}
      >
        <WorkspaceConnectionStatus state={props.catalogState} onPress={props.onOpenEnvironments} />
      </View>
    ) : null;

  if (!hasAnyThreads) {
    return (
      <View
        className="flex-1 items-center justify-center bg-screen px-8"
        style={{
          paddingBottom: Math.max(insets.bottom, 24),
          paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
        }}
      >
        <View className="w-full max-w-[430px]">
          <EmptyState
            title={emptyState.title}
            detail={emptyState.detail}
            actionLabel={!props.catalogState.hasReadyEnvironment ? "Add machine" : undefined}
            onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
            variant="plain"
          />
          {emptyState.loading && !shouldShowConnectionStatus ? (
            <View className="mt-4 items-center">
              <ActivityIndicator color={accentColor} />
            </View>
          ) : null}
          {shouldShowConnectionStatus && Platform.OS === "ios" ? (
            <View className="mt-4">
              <WorkspaceConnectionStatus
                state={props.catalogState}
                onPress={props.onOpenEnvironments}
                variant="sidebar"
              />
            </View>
          ) : null}
        </View>
        {connectionStatus}
      </View>
    );
  }

  const listHeader = (
    <>
      {Platform.OS === "ios" ? null : <HomeTopContentSpacer />}
      {shouldShowConnectionStatus && Platform.OS === "ios" ? (
        <View className="pb-4">
          <WorkspaceConnectionStatus
            state={props.catalogState}
            onPress={props.onOpenEnvironments}
            variant="sidebar"
          />
        </View>
      ) : null}
      {pendingTasks.map((pendingTask, index) => (
        <PendingTaskListRow
          key={pendingTask.message.messageId}
          variant="compact"
          pendingTask={pendingTask}
          environmentLabel={
            props.savedConnectionsById[pendingTask.message.environmentId]?.environmentLabel ?? null
          }
          isLast={index === pendingTasks.length - 1}
          onSelectPendingTask={props.onSelectPendingTask}
          onDeletePendingTask={props.onDeletePendingTask}
        />
      ))}
    </>
  );
  const listEmpty =
    pendingTasks.length > 0 ? null : hasSearchQuery ? (
      <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
    ) : selectedProjectScope !== null ? (
      <EmptyState
        title={`No threads in ${selectedProjectScope.title}`}
        detail="Choose another project or create a new task."
      />
    ) : (
      <EmptyState title="No threads yet" detail="Create a task to start a new coding session." />
    );

  return (
    <View className="flex-1 bg-screen">
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <FlatList
          data={threadListItems}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          extraData={{
            projectByKey,
            serverConfigs,
            savedConnectionsById: props.savedConnectionsById,
          }}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={listEmpty}
          style={{ flex: 1 }}
          automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingBottom:
              Platform.OS === "ios"
                ? Math.max(insets.bottom, 24) + 96
                : Math.max(insets.bottom, 16) + 88,
          }}
        />
      </SwipeableScrollGateProvider>
      {connectionStatus}
    </View>
  );
}
