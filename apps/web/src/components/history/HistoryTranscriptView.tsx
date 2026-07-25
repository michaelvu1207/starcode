/**
 * Read-only viewer for one terminal-history session.
 *
 * Renders in the right-hand pane where ChatView normally sits, and is
 * emphatically not ChatView: there is no composer, no approvals, no live tail.
 * This is a file on some machine's disk being previewed, and the header says so.
 *
 * Loading is tail-first. The first request returns the newest page and the
 * viewer opens at the bottom, which is what makes a 38 MB session open as fast
 * as a small one; "Load earlier" walks backwards from there.
 */
import type { EnvironmentId, HistorySessionId, HistoryTranscriptEntry } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useHistoryTranscriptPage } from "../../state/terminalHistory";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { HistoryProviderIcon, historyProviderLabel } from "../sidebar/HistoryProviderIcon";
import {
  foldTranscriptPages,
  formatSessionSize,
  HISTORY_TRANSCRIPT_PAGE_SIZE,
  MAX_TRANSCRIPT_PAGES,
  shouldAutoContinue,
  type TranscriptRow,
} from "./HistoryTranscript.logic";

export function HistoryTranscriptView(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: HistorySessionId;
  readonly machineLabel: string;
  /**
   * False until the environment registry knows this machine.
   *
   * Load-bearing. A route mounts on the first paint, before the registry has
   * been populated, and `runInEnvironment` fails outright with "environment is
   * not registered" — which the atom then caches, so the pane stays broken for
   * the rest of the session even though the connection comes up a moment
   * later. The sidebar strip never hits this only because it renders from the
   * environments list and so cannot exist before one. This gate gives the
   * route the same guarantee.
   */
  readonly ready: boolean;
}): ReactNode {
  // `befores[0]` is undefined: the first request is the tail. Each later entry
  // is the cursor the previous page handed back.
  const [befores, setBefores] = useState<ReadonlyArray<number | undefined>>([undefined]);

  const pages = useTranscriptPages(
    props.environmentId,
    props.sessionId,
    props.ready ? befores : [],
  );
  const loaded = useMemo(
    () => pages.flatMap((page) => (page.data === null ? [] : [page.data])),
    [pages],
  );
  const pending = !props.ready || pages.some((page) => page.isPending);
  const state = useMemo(() => foldTranscriptPages(loaded), [loaded]);

  const loadEarlier = useCallback(() => {
    if (state.nextBefore === null) return;
    const next = state.nextBefore;
    setBefores((current) =>
      current.length >= MAX_TRANSCRIPT_PAGES || current.includes(next)
        ? current
        : [...current, next],
    );
  }, [state.nextBefore]);

  // A long run of records that render to nothing - the image-generation
  // sessions - comes back as an empty but honest page. Following it
  // automatically for a few hops is the difference between "loading" and an
  // empty pane the reader has to click through by hand.
  useEffect(() => {
    if (shouldAutoContinue({ pending, pageCount: befores.length, state })) loadEarlier();
  }, [befores.length, loadEarlier, pending, state]);

  const session = state.session;
  // A machine that cannot serve history at all, versus one that tried and
  // failed. Worth separating: the first is expected during a rollout, the
  // second is something the reader can act on.
  const failure = pages.find((page) => page.error !== null)?.error ?? null;
  const unsupported = !pending && loaded.length === 0;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        {session === null ? null : (
          <HistoryProviderIcon
            provider={session.provider}
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">
              {session?.projectLabel ?? "Terminal session"}
            </span>
            <span className="shrink-0 rounded border border-border/70 px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
              Read-only
            </span>
          </div>
          <span className="truncate font-mono text-[11px] text-muted-foreground/60">
            {[
              session === null ? null : historyProviderLabel(session.provider),
              props.machineLabel,
              session?.projectPath,
              session === null ? null : formatRelativeTimeLabel(session.lastActivityAt),
              session === null ? null : formatSessionSize(session.sizeBytes),
              props.sessionId,
            ]
              .filter((part) => part !== null && part !== undefined && part !== "")
              .join(" · ")}
          </span>
        </div>
      </header>

      {/* Above the list, because older is up: this is the same direction the
          reader scrolls to reach it. */}
      {state.hasMore && failure === null ? (
        <div className="shrink-0 border-b border-border/60 px-4 py-1.5">
          <button
            type="button"
            onClick={loadEarlier}
            disabled={pending || befores.length >= MAX_TRANSCRIPT_PAGES}
            data-testid="history-load-earlier"
            className="mx-auto flex h-6 items-center justify-center rounded-md border border-dashed border-border px-3 font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:bg-background/45 hover:text-foreground disabled:opacity-50"
          >
            {pending
              ? "Reading…"
              : befores.length >= MAX_TRANSCRIPT_PAGES
                ? "Preview limit reached"
                : "Load earlier"}
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 [&>div]:h-full">
        {failure !== null ? (
          <CenteredNote>
            This session could not be read from {props.machineLabel}.
            <span className="mt-1 block font-mono text-[11px] text-muted-foreground/30">
              {failure}
            </span>
          </CenteredNote>
        ) : unsupported ? (
          <CenteredNote>
            {props.machineLabel} does not offer terminal history. Its server needs an update.
          </CenteredNote>
        ) : state.rows.length === 0 ? (
          <CenteredNote>{pending ? "Reading…" : "No messages in this session."}</CenteredNote>
        ) : (
          <LegendList<TranscriptRow>
            // Remounting per session keeps the initial anchor honest: the same
            // component reused for a different transcript would otherwise open
            // wherever the previous one was left.
            key={props.sessionId}
            data={state.rows}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={220}
            initialScrollIndex={state.rows.length - 1}
            initialScrollAtEnd
            // `initialScrollAtEnd` anchors using the *estimated* heights, and
            // these entries vary from one line to four thousand characters, so
            // on its own the view settles well short of the bottom once rows
            // measure. Re-pinning on `itemLayout` fixes that — but only until
            // the reader loads an earlier page, after which yanking them back
            // to the newest message is the opposite of what they asked for.
            maintainScrollAtEnd={
              befores.length === 1
                ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
                : false
            }
          />
        )}
      </div>
    </div>
  );
}

function CenteredNote(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-sm text-muted-foreground/40">{props.children}</p>
    </div>
  );
}

const keyExtractor = (row: TranscriptRow): string => row.id;
const getItemType = (row: TranscriptRow): string => row.entry.role;

// Stable and dependency-free: LegendList memoizes rows, so a renderItem that
// closes over changing state would defeat the virtualization.
const renderItem = ({ item }: { item: TranscriptRow }): ReactNode => (
  <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip px-4">
    <TranscriptEntryRow entry={item.entry} />
  </div>
);

function TranscriptEntryRow(props: { readonly entry: HistoryTranscriptEntry }): ReactNode {
  const { entry } = props;
  const isUser = entry.role === "user";
  return (
    <div className={cn("pb-4", isUser ? "flex flex-col items-end" : null)}>
      <div
        className={cn(
          "min-w-0",
          isUser ? "max-w-[80%] rounded-2xl bg-accent px-3 py-2" : "w-full px-1 py-0.5",
        )}
      >
        {entry.text.length > 0 ? (
          // Plain pre-wrapped text, not ChatMarkdown: this is a preview of a
          // file, and rendering it as live markdown would invite link and
          // image fetches from content this app did not produce.
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
            {entry.text}
            {entry.truncated ? (
              <span className="ml-1 text-[11px] text-muted-foreground/50">(clipped)</span>
            ) : null}
          </p>
        ) : null}
        {entry.toolCalls.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.toolCalls.map((name) => (
              <span
                key={name}
                className="rounded border border-border/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground/70"
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {entry.timestamp === null ? null : (
        <span
          className={cn(
            "mt-1 block font-mono text-[10px] tabular-nums text-muted-foreground/35",
            isUser ? "pe-1 text-right" : "px-1",
          )}
        >
          {formatRelativeTimeLabel(entry.timestamp)}
        </span>
      )}
    </div>
  );
}

/**
 * Fixed-arity hook fan-out over the requested pages, for the same reason the
 * sidebar strip needs one: hooks cannot be called in a variable-length loop,
 * and every page needs its own atom subscription.
 */
function useTranscriptPages(
  environmentId: EnvironmentId,
  sessionId: HistorySessionId,
  befores: ReadonlyArray<number | undefined>,
) {
  const keyAt = (index: number) => {
    if (index >= befores.length) return null;
    const before = befores[index];
    return {
      environmentId,
      sessionId,
      ...(before === undefined ? {} : { before }),
      limit: HISTORY_TRANSCRIPT_PAGE_SIZE,
    };
  };
  /* eslint-disable react-hooks/rules-of-hooks -- fixed arity, see above. */
  const slots = [
    useHistoryTranscriptPage(keyAt(0)),
    useHistoryTranscriptPage(keyAt(1)),
    useHistoryTranscriptPage(keyAt(2)),
    useHistoryTranscriptPage(keyAt(3)),
    useHistoryTranscriptPage(keyAt(4)),
    useHistoryTranscriptPage(keyAt(5)),
    useHistoryTranscriptPage(keyAt(6)),
    useHistoryTranscriptPage(keyAt(7)),
    useHistoryTranscriptPage(keyAt(8)),
    useHistoryTranscriptPage(keyAt(9)),
    useHistoryTranscriptPage(keyAt(10)),
    useHistoryTranscriptPage(keyAt(11)),
  ];
  /* eslint-enable react-hooks/rules-of-hooks */
  return slots.slice(0, Math.min(befores.length, MAX_TRANSCRIPT_PAGES));
}
