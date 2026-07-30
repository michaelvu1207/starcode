/**
 * The conversation a thread inherited, above the conversation it is having.
 *
 * An imported or forked thread opens empty and answers as though it remembers
 * hundreds of messages, because it does — the provider resumed the original
 * session and the model's context came back with it. F12 defused that with one
 * line of provenance. This is the rest of the answer: the same line, now
 * something you can open.
 *
 * Three properties keep it from becoming the history viewer F12 deleted.
 *
 * **Nothing is read until it is asked for.** These sessions run past 38 MB and
 * one on this machine reaches 638 MB, so the collapsed state costs no request
 * at all — the summary comes from the provenance registry the thread view has
 * already read for its own reasons. The first page is fetched on the first
 * expand, and no page is ever fetched to find out whether another exists.
 *
 * **It is scoped to one thread's own session.** There is no route here, no
 * session picker, and no way to reach another machine's history: this renders
 * only for the session the thread in front of you resumed.
 *
 * **It reads as inherited, not as said.** Muted messages in a recessed region
 * with no action affordances — no copy, no revert, no diff — because
 * everything below it is live and the two must not compete for the same
 * attention.
 */
import type { EnvironmentId, HistorySessionId, HistoryTranscriptEntry } from "@starcode/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useHistoryEntriesPage } from "~/state/terminalHistory";
import { HistoryMessage } from "../history/HistoryMessage";
import { HistoryProviderIcon } from "../sidebar/HistoryProviderIcon";
import { Spinner } from "../ui/spinner";
import {
  canLoadEarlier,
  initialHistoryPaging,
  loadEarlierHistoryPage,
  oldestCursorIndex,
  reportOldestPage,
  type HistoryPagingState,
  type ThreadHistoryModel,
} from "./ThreadHistory.logic";

/**
 * Entries per page.
 *
 * Enough that opening the section lands you in the middle of a conversation
 * rather than at the end of a sentence, and few enough that the first page
 * arrives without a visible wait on a session of any size.
 */
const THREAD_HISTORY_PAGE_SIZE = 30;

export function ThreadHistorySection(props: {
  readonly environmentId: EnvironmentId;
  readonly model: ThreadHistoryModel;
  readonly sessionId: HistorySessionId;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [paging, setPaging] = useState<HistoryPagingState>(() =>
    initialHistoryPaging(props.model.before),
  );

  const onPageResolved = useCallback(
    (input: { readonly cursorIndex: number; readonly nextBefore: number | null }) => {
      setPaging((current) =>
        // Only the page currently at the top reports. A late answer from one
        // further down would otherwise re-offer a cursor already spent.
        input.cursorIndex === oldestCursorIndex(current)
          ? reportOldestPage(current, input.nextBefore)
          : current,
      );
    },
    [],
  );

  const showEarlier = useCallback(() => setPaging(loadEarlierHistoryPage), []);

  return (
    <section
      data-testid="thread-history-section"
      data-expanded={expanded ? "true" : "false"}
      className="flex shrink-0 flex-col border-b border-border/50"
    >
      <button
        type="button"
        data-testid="thread-history-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full shrink-0 items-center justify-center gap-1.5 px-4 py-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <HistoryProviderIcon
          provider={props.model.provider}
          className="size-3 shrink-0 opacity-60"
        />
        <span className="font-medium">Earlier conversation</span>
        <span className="truncate">· {props.model.summary}</span>
      </button>
      {expanded ? (
        <div
          data-testid="thread-history-panel"
          // Bounded and separately scrollable: this sits above a timeline that
          // owns the rest of the column, and history that pushed the live
          // conversation off screen would have inverted which of the two the
          // view is about.
          // `bg-card` rather than `bg-muted`: the muted token in this theme is
          // 6% of a cream over transparent, so a tint of it is invisible against
          // the app background. This region has to read as *not* part of the
          // conversation below it at a glance, not on inspection, so it takes
          // the same recessed surface panels elsewhere use — plus a little
          // transparency, since the theme's backdrop should still show through.
          className="flex max-h-[45vh] min-h-0 shrink-0 flex-col overflow-y-auto bg-card/70 px-5 py-3 opacity-85"
        >
          {canLoadEarlier(paging) ? (
            <button
              type="button"
              data-testid="thread-history-show-earlier"
              onClick={showEarlier}
              className="mx-auto mb-3 shrink-0 rounded-full border border-border/60 px-3 py-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
            >
              Show earlier
            </button>
          ) : null}
          {/* Reversed: the cursor list grows newest-first as paging walks
              backwards, and reading order is the opposite. */}
          {paging.cursors
            .map((cursor, index) => ({ cursor, index }))
            .toReversed()
            .map(({ cursor, index }) => (
              <HistoryPage
                key={cursor ?? "end"}
                environmentId={props.environmentId}
                sessionId={props.sessionId}
                before={cursor}
                cursorIndex={index}
                onResolved={onPageResolved}
              />
            ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One page, as its own component.
 *
 * Not a loop of hooks in the parent, which React forbids the moment the list
 * grows — and it grows every time somebody loads earlier. Each page owning its
 * own atom subscription also means a page fetched once stays cached, so
 * collapsing the section and reopening it costs nothing.
 */
function HistoryPage(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: HistorySessionId;
  readonly before: number | null;
  readonly cursorIndex: number;
  readonly onResolved: (input: {
    readonly cursorIndex: number;
    readonly nextBefore: number | null;
  }) => void;
}): ReactNode {
  const page = useHistoryEntriesPage({
    environmentId: props.environmentId,
    sessionId: props.sessionId,
    ...(props.before === null ? {} : { before: props.before }),
    limit: THREAD_HISTORY_PAGE_SIZE,
  });

  const { onResolved, cursorIndex } = props;
  // `undefined` while the page is still arriving; the parent ignores it until
  // it settles. A machine that cannot serve the route resolves to null data,
  // which reads here as "nothing earlier" — the right answer, since there is
  // no cursor to continue from either.
  const nextBefore =
    page.isPending && page.data === null ? undefined : (page.data?.nextBefore ?? null);
  useEffect(() => {
    if (nextBefore === undefined) return;
    onResolved({ cursorIndex, nextBefore });
  }, [nextBefore, cursorIndex, onResolved]);

  if (page.isPending && page.data === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        Reading the earlier conversation…
      </div>
    );
  }
  if (page.data === null) {
    return (
      <p className="py-3 text-center text-xs text-muted-foreground/70">
        This machine cannot show the earlier conversation.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 pb-3 empty:hidden">
      {page.data.entries.map((entry: HistoryTranscriptEntry) => (
        <HistoryMessage key={entry.offset} entry={entry} cwd={null} muted />
      ))}
    </div>
  );
}
