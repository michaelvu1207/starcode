import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import type { OrchestrationThreadSubagent } from "@t3tools/contracts";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadPr } from "../../state/use-thread-pr";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { resolveThreadListV2Status, type ThreadListV2Status } from "./threadListV2";

/**
 * Thread List v2 renders one flat native list: rich edge-to-edge rows with
 * native swipe and long-press actions. State reads through colored status
 * labels and text hierarchy rather than card fills.
 *
 * One row shape, because a thread has one state that matters here: on the
 * list, or archived off it. Swiping a row archives it, which is the same act
 * the long-press menu leads with.
 */

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

// Status hues follow the system-wide convention set by sidebar v1 and the
// Live Activity/widgets (amber approval, indigo input, sky working) so a
// thread reads the same color everywhere it surfaces.
const STATUS_LABEL_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "Approval", className: "text-amber-700 dark:text-amber-300" },
  input: { label: "Input", className: "text-indigo-600 dark:text-indigo-300" },
  working: { label: "Working", className: "text-sky-600 dark:text-sky-400" },
  // Shares working's sky hue because it is the same kind of fact — work is
  // happening — and the wording carries the difference: the thread itself has
  // stopped, its agents have not. A fourth hue would imply a fourth category.
  agents: { label: "Agents", className: "text-sky-600 dark:text-sky-400" },
  failed: { label: "Failed", className: "text-red-700 dark:text-red-300" },
};

function threadTimeLabel(thread: EnvironmentThreadShell): string {
  return relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
}

const ROW_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

/** Rounded-row radius shared with the v1 sidebar rows. */
const SIDEBAR_V2_ROW_RADIUS = 12;

/**
 * A subagent, as a child row beneath the thread that spawned it.
 *
 * Shares the thread row's metrics but nothing else: no swipe, no long-press
 * menu, no PR chip. An agent is not yours to archive or delete, only to open
 * and read, so the row offers exactly one gesture. The left inset is the whole
 * hierarchy signal — a connector rule would fight the flat, edge-to-edge idiom
 * the rest of the list is built on.
 */
export const ThreadListV2AgentRow = memo(function ThreadListV2AgentRow(props: {
  readonly agent: OrchestrationThreadSubagent;
  readonly thread: EnvironmentThreadShell;
  readonly pane?: "screen" | "sidebar";
  readonly onSelectAgent: (thread: EnvironmentThreadShell, taskId: string) => void;
}) {
  const { agent, thread, onSelectAgent } = props;
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const screenColor = useThemeColor("--color-screen");
  const drawerColor = useThemeColor("--color-drawer");
  const sidebarPane = props.pane === "sidebar";

  const handlePress = useCallback(
    () => onSelectAgent(thread, agent.taskId),
    [agent.taskId, onSelectAgent, thread],
  );

  // Description is the caller's own words and always wins; the type is the
  // fallback for an agent that never reported one. A nameless row still beats
  // a dropped one, because the alternative is under-reporting what is running.
  const label = agent.description ?? agent.subagentType ?? "Agent";
  const subtitle = agent.status === "paused" ? "Paused" : agent.lastToolName;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open agent ${label}`}
      onPress={handlePress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? pressedBackgroundColor : sidebarPane ? drawerColor : screenColor,
        ...(sidebarPane ? { borderRadius: SIDEBAR_V2_ROW_RADIUS } : {}),
      })}
    >
      <View className="flex-row items-center gap-2 py-2 pr-4 pl-10">
        <Text className="flex-1 text-[14px] text-secondary" numberOfLines={1}>
          {label}
        </Text>
        {subtitle ? (
          <Text className="text-[11px] text-tertiary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly providerDriver: string | null;
  /** Which machine hosts the thread. Null when only one environment is
      connected — repeating the same label on every row is noise. Mirrors
      the web sidebar's remote-environment cloud icon, but as text since
      phones have no hover tooltips. */
  readonly environmentLabel: string | null;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color —
      matching the v1 sidebar rows. */
  readonly pane?: "screen" | "sidebar";
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly projectCwd?: string | null;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const { thread, onSelectThread, onDeleteThread, onArchiveThread } = props;

  const pr = useThreadPr(thread, props.projectCwd ?? props.project?.workspaceRoot ?? null);

  const screenColor = useThemeColor("--color-screen");
  const drawerColor = useThemeColor("--color-drawer");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const selectedBackgroundColor = useThemeColor("--color-user-bubble");
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;

  const status = resolveThreadListV2Status(thread);
  const statusLabel = STATUS_LABEL_BY_STATUS[status];
  const timeLabel = threadTimeLabel(thread);

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete],
  );

  // Swipe: archive is the one thing you do to a thread you are finished with,
  // so it is what the swipe commits to.
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  );

  // The sidebar pane fills selected rows with the accent color (matching the
  // v1 sidebar), so every piece of row text needs a white-on-accent variant.
  const cardContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={thread.environmentId}
            size={15}
            projectTitle={props.projectTitle ?? props.project.title}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text
          className={cn(
            "flex-1 text-sm font-t3-medium",
            selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {props.projectTitle ?? props.project?.title ?? ""}
        </Text>
        <Text
          className={cn(
            "text-xs tabular-nums",
            selected ? "text-white" : (statusLabel?.className ?? "text-foreground-tertiary"),
          )}
        >
          {statusLabel?.label ?? timeLabel}
        </Text>
      </View>
      <Text
        className={cn(
          "mt-1 text-base font-t3-medium",
          selected ? "text-user-bubble-foreground" : "text-foreground",
        )}
        numberOfLines={2}
      >
        {thread.title}
      </Text>
      <View className="mt-1 flex-row items-center gap-2">
        {status === "failed" && thread.session?.lastError ? (
          <Text
            className={cn(
              "flex-1 text-xs",
              selected
                ? "text-user-bubble-foreground-muted"
                : "text-red-600/80 dark:text-red-400/80",
            )}
            numberOfLines={1}
          >
            {thread.session.lastError}
          </Text>
        ) : thread.branch || props.environmentLabel ? (
          /* "branch · machine" share one truncating line. The machine sits
             last so a tight fit cuts the repetitive label, not the branch —
             and machine-only fills the row for non-git projects. */
          <Text
            className={cn(
              "flex-1 text-xs",
              selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {thread.branch ? (
              <Text
                className={cn(
                  "text-xs",
                  selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {thread.branch}
              </Text>
            ) : null}
            {thread.branch && props.environmentLabel ? "  ·  " : null}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "text-xs",
                  selected ? "text-user-bubble-foreground-muted" : "text-foreground-tertiary",
                )}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        {pr ? (
          <Text
            accessibilityLabel={pr.accessibilityLabel}
            className={cn("text-xs", selected ? "text-white" : pr.textClassName)}
            style={{ fontFamily: MONO_FONT }}
          >
            #{pr.label}
          </Text>
        ) : null}
        {props.providerDriver ? (
          <View className="opacity-60">
            <ProviderIcon provider={props.providerDriver} size={14} />
          </View>
        ) : null}
      </View>
    </>
  );

  const rowContent = (close: () => void) => (
    <Pressable
      accessibilityHint={`Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`}
      accessibilityLabel={thread.title}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        close();
        onSelectThread(thread);
      }}
      style={
        sidebarPane
          ? ({ pressed }) => ({
              backgroundColor: selected
                ? selectedBackgroundColor
                : pressed
                  ? pressedBackgroundColor
                  : drawerColor,
              borderRadius: SIDEBAR_V2_ROW_RADIUS,
              paddingHorizontal: 12,
              paddingVertical: 10,
            })
          : ({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })
      }
    >
      {sidebarPane ? (
        cardContent
      ) : (
        /* Flat native list rows: no tonal containers — colored status
             labels and text hierarchy carry state, an inset hairline
             separates rows. The opaque screen background stays so swipe
             actions reveal behind the row. */
        <View className="bg-screen">
          <View className="px-5 py-2.5">{cardContent}</View>
          <View className="ml-5 h-px bg-border-subtle" />
        </View>
      )}
    </Pressable>
  );

  return (
    <ThreadSwipeable
      backgroundColor={sidebarPane ? drawerColor : screenColor}
      containerStyle={
        sidebarPane ? { borderRadius: SIDEBAR_V2_ROW_RADIUS, overflow: "hidden" } : undefined
      }
      enableTrackpadSwipe
      // Full swipe commits the advertised action (Archive), never the
      // destructive delete.
      fullSwipeAction="primary"
      fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
      onDelete={handleDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={primaryAction}
      resetKey={`${thread.environmentId}:${thread.id}`}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={thread.title}
    >
      {(close) => (
        <ControlPillMenu
          actions={ROW_MENU_ACTIONS}
          onPressAction={handleMenuAction}
          shouldOpenOnLongPress
        >
          {rowContent(close)}
        </ControlPillMenu>
      )}
    </ThreadSwipeable>
  );
});
