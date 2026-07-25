/**
 * Fork-owned: the orchestration board.
 *
 * Every thread on every machine, as cards grouped by the machine running it.
 * The status on a card is derived from live session state — the same source the
 * sidebar reads — rather than from anything an agent reports about itself.
 *
 * Cards started by the master carry a tag. That association is read from the
 * master's own transcript (see `Workbench.master`), so it is present for work
 * the master started and honestly absent for everything else.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { useNavigate } from "@tanstack/react-router";
import { ServerIcon, SparklesIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { sidebarConnectionDotClassName } from "../Sidebar.connections";
import { partitionSidebarV2Threads } from "../Sidebar.partition";
import { ThreadTaskProgress } from "../sidebar/ThreadTaskProgress";
import { hasThreadTaskProgress } from "../sidebar/ThreadTaskProgress.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import {
  buildWorkbenchBoard,
  type WorkbenchBoardCard,
  type WorkbenchBoardGroup,
} from "./Workbench.board";
import {
  toneForThreadStatus,
  WORKBENCH_TONE_DOT_CLASS,
  WORKBENCH_TONE_LABEL,
} from "./Workbench.tone";

/** No change-request state on the board: it only feeds auto-settle, and the
    board's settled shelf is a toggle rather than a ranking. */
const NO_CHANGE_REQUESTS: ReadonlyMap<string, "open" | "closed" | "merged"> = new Map();

const BoardCard = memo(function BoardCard({
  card,
  projectTitle,
  onOpen,
}: {
  card: WorkbenchBoardCard;
  projectTitle: string | null;
  onOpen: (card: WorkbenchBoardCard) => void;
}) {
  const tone = toneForThreadStatus(card.status);
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      data-testid="workbench-board-card"
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-left transition-colors",
        "hover:border-border hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        card.section === "settled" && "opacity-60",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={WORKBENCH_TONE_LABEL[tone]}
                className={cn("size-1.5 shrink-0 rounded-full", WORKBENCH_TONE_DOT_CLASS[tone])}
              />
            }
          />
          <TooltipPopup side="top">{WORKBENCH_TONE_LABEL[tone]}</TooltipPopup>
        </Tooltip>
        {projectTitle !== null ? (
          <span className="max-w-28 shrink-0 truncate text-[11px] text-muted-foreground/70">
            {projectTitle}
          </span>
        ) : null}
        {card.masterCreated ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  data-testid="workbench-master-tag"
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-primary/40 px-1 py-px text-[10px] text-primary"
                >
                  <SparklesIcon aria-hidden className="size-2.5" />
                  master
                </span>
              }
            />
            <TooltipPopup side="top">Started by the master thread</TooltipPopup>
          </Tooltip>
        ) : null}
      </span>

      <span className="min-w-0 truncate text-xs text-foreground">{card.thread.title}</span>

      <span className="flex min-w-0 items-center gap-1.5">
        {hasThreadTaskProgress(card.thread.planSummary) ? (
          <ThreadTaskProgress summary={card.thread.planSummary} />
        ) : (
          <span className="flex-1" />
        )}
      </span>
    </button>
  );
});

function BoardGroup({
  group,
  projectTitleByKey,
  onOpen,
}: {
  group: WorkbenchBoardGroup;
  projectTitleByKey: ReadonlyMap<string, string>;
  onOpen: (card: WorkbenchBoardCard) => void;
}) {
  return (
    <section className="pb-5">
      <header className="flex min-w-0 items-center gap-2 pb-2">
        <ConnectionStatusDot
          tooltipText={
            group.connection === null
              ? "Not connected. This machine is no longer one of your connections."
              : connectionStatusText(group.connection)
          }
          dotClassName={sidebarConnectionDotClassName(group.connection)}
          pingClassName={
            group.connection?.phase === "connecting" || group.connection?.phase === "reconnecting"
              ? "bg-warning/60 duration-2000"
              : null
          }
        />
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ServerIcon aria-hidden className="size-3.5 text-muted-foreground/60" />
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {group.label}
          </span>
        </span>
        {group.isLocal ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/60">Local</span>
        ) : null}
        <span className="h-px flex-1 bg-border/50" />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">
          {group.cards.length}
        </span>
      </header>

      {group.cards.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/40">
          {group.settledHiddenCount > 0
            ? `Nothing running. ${group.settledHiddenCount} finished.`
            : "Nothing running here."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 @md/board:grid-cols-2 @2xl/board:grid-cols-3">
          {group.cards.map((card) => (
            <BoardCard
              key={card.key}
              card={card}
              projectTitle={
                projectTitleByKey.get(`${card.thread.environmentId}:${card.thread.projectId}`) ??
                null
              }
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function WorkbenchBoard({
  masterThreadKey,
  masterCreatedThreadIds,
}: {
  masterThreadKey: string | null;
  masterCreatedThreadIds: ReadonlySet<string>;
}) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const nowMinute = useNowMinute();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [showSettled, setShowSettled] = useState(false);

  const board = useMemo(() => {
    const partition = partitionSidebarV2Threads({
      threads,
      scopedProjectKeys: null,
      serverConfigs,
      changeRequestStateByKey: NO_CHANGE_REQUESTS,
      autoSettleAfterDays,
      threadLastVisitedAtById,
      // The board exists to show what needs a human, so it always ranks by
      // attention rather than following the sidebar's sort preference.
      threadSortOrder: "activity",
      nowMinute,
    });
    return buildWorkbenchBoard({
      activeThreads: partition.activeThreads,
      snoozedThreads: partition.snoozedThreads,
      settledThreads: partition.settledThreads,
      environments,
      primaryEnvironmentId,
      masterCreatedThreadIds,
      masterThreadKey,
      showSettled,
    });
  }, [
    autoSettleAfterDays,
    environments,
    masterCreatedThreadIds,
    masterThreadKey,
    nowMinute,
    primaryEnvironmentId,
    serverConfigs,
    showSettled,
    threadLastVisitedAtById,
    threads,
  ]);

  const projectTitleByKey = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [`${project.environmentId}:${project.id}`, project.title] as const,
        ),
      ),
    [projects],
  );

  const settledHiddenTotal = board.groups.reduce(
    (total, group) => total + group.settledHiddenCount,
    0,
  );

  const openCard = (card: WorkbenchBoardCard) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(card.thread.environmentId, card.thread.id)),
    });
  };

  return (
    <div className="@container/board flex min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-xs font-medium text-foreground">Work in flight</h2>
        <span className="font-mono text-[11px] text-muted-foreground/60">{board.cardCount}</span>
        <span className="flex-1" />
        {settledHiddenTotal > 0 || showSettled ? (
          <button
            type="button"
            onClick={() => setShowSettled((current) => !current)}
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground"
          >
            {showSettled ? "Hide finished" : `Show finished (${settledHiddenTotal})`}
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        {board.groups.length === 0 ? (
          <p className="text-xs text-muted-foreground/60">
            No machines connected yet. Pair one and its threads appear here.
          </p>
        ) : (
          board.groups.map((group) => (
            <BoardGroup
              key={group.environmentId}
              group={group}
              projectTitleByKey={projectTitleByKey}
              onOpen={openCard}
            />
          ))
        )}
      </div>
    </div>
  );
}
