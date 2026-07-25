/**
 * The per-connection "Terminal history" strip.
 *
 * Sessions Claude Code and Codex wrote on that machine, outside t3 entirely.
 * Preview only: a row opens a read-only viewer, nothing is imported.
 *
 * Lazy by construction. The strip is its own component so that its atom
 * subscriptions mount and unmount with the sub-section's own collapse state,
 * which defaults closed — expanding the sidebar costs nothing, and only asking
 * for a machine's history fetches from it. Pages accumulate in component state;
 * how deep you paged is not worth persisting, only whether the strip is open.
 */
import type { EnvironmentId, HistorySessionSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { useHistorySessionsPage } from "../../state/terminalHistory";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  foldHistoryStripPages,
  historySessionsKeyFor,
  historyStripMoreLabel,
  historyStripUnsupported,
  resolveSidebarTerminalHistoryExpanded,
  sidebarTerminalHistoryExpansionKey,
  HISTORY_STRIP_FIRST_PAGE,
  type HistoryStripPageRequest,
} from "../Sidebar.history";
import { HistoryProviderIcon } from "./HistoryProviderIcon";

export function SidebarTerminalHistoryStrip(props: {
  readonly environmentId: EnvironmentId;
  /** False while the parent connection group is collapsed: fetch nothing. */
  readonly groupExpanded: boolean;
}): ReactNode {
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const expanded = resolveSidebarTerminalHistoryExpanded(projectExpandedById, props.environmentId);
  const active = props.groupExpanded && expanded;

  const toggle = useCallback(() => {
    setProjectExpanded(sidebarTerminalHistoryExpansionKey(props.environmentId), !expanded);
  }, [expanded, props.environmentId, setProjectExpanded]);

  return (
    <>
      <li data-thread-selection-safe className="list-none">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          data-testid="sidebar-v2-history-toggle"
          data-environment-id={props.environmentId}
          className="mb-0.5 mt-1.5 flex w-full cursor-pointer items-center gap-1.5 px-2.5 text-left"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-2.5 shrink-0 text-muted-foreground/40 transition-transform",
              !expanded && "-rotate-90",
            )}
          />
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/50">
            Terminal history
          </span>
          <span className="h-px flex-1 bg-sidebar-border/40" />
        </button>
      </li>
      {active ? <TerminalHistoryRows environmentId={props.environmentId} /> : null}
    </>
  );
}

/**
 * Split from the strip so the whole atom chain unmounts on collapse rather
 * than merely rendering nothing.
 */
function TerminalHistoryRows(props: { readonly environmentId: EnvironmentId }): ReactNode {
  const [requests, setRequests] = useState<ReadonlyArray<HistoryStripPageRequest>>([
    HISTORY_STRIP_FIRST_PAGE,
  ]);

  // One hook per requested page, in a fixed-length array so hook order is
  // stable: pages are only ever appended, never removed, while mounted.
  const pages = useHistoryStripPages(props.environmentId, requests);

  const loaded = useMemo(
    () =>
      pages.flatMap((entry, index) => {
        const request = requests[index];
        return entry.data === null || request === undefined ? [] : [{ request, page: entry.data }];
      }),
    [pages, requests],
  );
  const state = useMemo(() => foldHistoryStripPages(loaded), [loaded]);

  const pending = pages.some((entry) => entry.isPending);
  const firstPage = pages[0]?.data ?? null;
  const loadMore = useCallback(() => {
    if (state.nextRequest === null) return;
    const next = state.nextRequest;
    setRequests((current) => [...current, next]);
  }, [state.nextRequest]);

  if (historyStripUnsupported({ pending, firstPage })) {
    // A machine on a build without the history routes. Stated plainly and once
    // — not an error, not a spinner that never resolves.
    return (
      <li className="list-none px-2.5 pb-1 text-[11px] text-muted-foreground/40">
        History needs a server update on this machine
      </li>
    );
  }

  if (pending && state.sessions.length === 0) {
    return <li className="list-none px-2.5 pb-1 text-[11px] text-muted-foreground/40">Reading…</li>;
  }

  if (state.sessions.length === 0) {
    return (
      <li className="list-none px-2.5 pb-1 text-[11px] text-muted-foreground/40">
        No terminal sessions in the last 7 days
      </li>
    );
  }

  const moreLabel = historyStripMoreLabel(state);
  return (
    <>
      {state.sessions.map((session) => (
        <HistoryRow key={session.id} environmentId={props.environmentId} session={session} />
      ))}
      {moreLabel !== null ? (
        <li className="list-none px-1">
          <button
            type="button"
            onClick={loadMore}
            disabled={pending}
            data-testid="sidebar-v2-history-more"
            className="mt-1 flex h-[26px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border font-mono text-[10px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground disabled:opacity-50 dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
          >
            {pending ? "Reading…" : moreLabel}
          </button>
        </li>
      ) : null}
    </>
  );
}

function HistoryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly session: HistorySessionSummary;
}): ReactNode {
  const { session } = props;
  const hasSnippet = session.snippet !== null;
  const label = session.snippet ?? session.projectLabel ?? "Untitled session";
  // With no snippet the label already *is* the project, so repeating it in the
  // trailing column would spend the row's scarcest resource — width — saying
  // the same word twice.
  const projectLabel = hasSnippet ? session.projectLabel : null;
  return (
    <li data-thread-selection-safe className="list-none" data-testid="sidebar-v2-history-row">
      <Link
        to="/$environmentId/history/$sessionId"
        params={{ environmentId: props.environmentId, sessionId: session.id }}
        title={`${session.projectPath ?? "unknown project"}\n${label}`}
        className="flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors hover:bg-sidebar-accent/60"
        activeProps={{ className: "bg-sidebar-accent" }}
      >
        <HistoryProviderIcon
          provider={session.provider}
          className="size-3 shrink-0 text-muted-foreground/60"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            hasSnippet ? "text-sidebar-foreground/70" : "italic text-muted-foreground/45",
          )}
        >
          {label}
        </span>
        {projectLabel === null ? null : (
          <span className="max-w-[4.5rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground/35">
            {projectLabel}
          </span>
        )}
        <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/40">
          {compactAge(session.lastActivityAt)}
        </span>
      </Link>
    </li>
  );
}

/** Matches the sidebar's own compact relative labels ("3h", not "3 hours ago"). */
const compactAge = (isoTimestamp: string): string => {
  const label = formatRelativeTimeLabel(isoTimestamp);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
};

/**
 * Fixed-arity hook fan-out over the requested pages.
 *
 * React forbids calling hooks in a loop of varying length, and each page needs
 * its own atom subscription. Capping the chain at a fixed number of hooks and
 * passing `null` for the unused slots keeps hook order constant while still
 * letting the strip page. The cap is generous: eight pages of twelve is a
 * hundred sessions in one strip, well past the point anyone scrolls.
 */
const MAX_STRIP_PAGES = 8;

function useHistoryStripPages(
  environmentId: EnvironmentId,
  requests: ReadonlyArray<HistoryStripPageRequest>,
) {
  const keyAt = (index: number) => {
    const request = requests[index];
    return request === undefined ? null : historySessionsKeyFor(environmentId, request);
  };
  /* eslint-disable react-hooks/rules-of-hooks -- fixed arity, see above. */
  const slots = [
    useHistorySessionsPage(keyAt(0)),
    useHistorySessionsPage(keyAt(1)),
    useHistorySessionsPage(keyAt(2)),
    useHistorySessionsPage(keyAt(3)),
    useHistorySessionsPage(keyAt(4)),
    useHistorySessionsPage(keyAt(5)),
    useHistorySessionsPage(keyAt(6)),
    useHistorySessionsPage(keyAt(7)),
  ];
  /* eslint-enable react-hooks/rules-of-hooks */
  return slots.slice(0, Math.min(requests.length, MAX_STRIP_PAGES));
}
