/**
 * The import picker: the only history surface starcode has.
 *
 * Reading old conversations is not a feature of this fork — resuming them is —
 * so this dialog is built around one action. The left pane names the CLI
 * sessions a machine has; the right pane shows just enough of the selected one
 * to be sure it is the right conversation (how it opened, where it ended up);
 * the footer resumes it as a real thread whose model still remembers
 * everything.
 *
 * Mounted once, near the command palette, and opened through the
 * `importPicker` window-event seam rather than by props. Two surfaces already
 * dispatch it — the per-machine row in the connections view and the
 * connections dropdown's footer — and neither knows this file exists.
 *
 * Machine scope is a selector rather than a first step. Opening from a
 * connection group preselects that machine; opening fleet-wide preselects the
 * local one. Either way the sessions are on screen immediately and switching
 * machines is one click, which a wizard page would have cost a round trip and
 * a back button.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  HistorySessionId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { readThreadShell, useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import {
  useHistoryImports,
  useHistoryPreview,
  useHistorySessionsPage,
  useImportHistorySession,
  useRefreshHistoryImports,
} from "~/state/terminalHistory";
import { buildThreadRouteParams } from "~/threadRoutes";
import { HistoryMessage } from "./HistoryMessage";
import { subscribeImportPicker } from "../sidebar/importPicker";
import { HistoryProviderIcon, historyProviderLabel } from "../sidebar/HistoryProviderIcon";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import {
  buildImportPickerRows,
  buildImportPreviewTimeline,
  matchesImportPickerFilter,
  resolveImportAttempt,
  resolveImportPickerScope,
  type ImportPickerRowModel,
  type ImportPrompt,
} from "./ImportConversationDialog.logic";

/**
 * Sessions asked for at once. The listing costs one head-read per row, so this
 * is disk work as well as response size — but a picker that only reaches back
 * a page is a picker you have to fight, and "load older" doubles it on demand.
 */
const IMPORT_PICKER_PAGE_SIZE = 60;
/** The server's own ceiling. Asking past it is refused, not clamped politely. */
const IMPORT_PICKER_MAX_SESSIONS = 200;

/**
 * How long to let the websocket deliver a thread the server has already
 * created. Generous, because the alternative to waiting is landing on the
 * wrong route, and cheap, because it only ever elapses on a connection that
 * has bigger problems.
 */
const IMPORTED_THREAD_ARRIVAL_TIMEOUT_MS = 8_000;
const IMPORTED_THREAD_POLL_INTERVAL_MS = 100;

async function waitForThreadShell(ref: ScopedThreadRef): Promise<void> {
  const deadline = Date.now() + IMPORTED_THREAD_ARRIVAL_TIMEOUT_MS;
  while (readThreadShell(ref) === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, IMPORTED_THREAD_POLL_INTERVAL_MS));
  }
}

export function ImportConversationDialog(): ReactNode {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverProjects = useProjects();
  const runImport = useImportHistorySession();

  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<HistorySessionId | null>(null);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(IMPORT_PICKER_PAGE_SIZE);
  const [prompt, setPrompt] = useState<ImportPrompt | null>(null);

  /**
   * Another connection that already has the folder this prompt wants to
   * register.
   *
   * Only ever a suggestion — the operator may genuinely mean to run here — but
   * it is the difference between a thread the whole fleet can see and one that
   * lives inside a single app process. Matched on `workspaceRoot`, which is the
   * same path the prompt is quoting, and excluding the connection we are on so
   * it cannot recommend itself.
   */
  const folderElsewhere = useMemo(() => {
    if (prompt?.kind !== "needsProject") return null;
    const match = serverProjects.find(
      (candidate) =>
        candidate.workspaceRoot === prompt.cwd && candidate.environmentId !== environmentId,
    );
    if (match === undefined) return null;
    const environment = environments.find(
      (candidate) => candidate.environmentId === match.environmentId,
    );
    return environment === undefined
      ? null
      : { environmentId: environment.environmentId, label: environment.label };
  }, [environmentId, environments, prompt, serverProjects]);
  const [busy, setBusy] = useState(false);
  // Ages are relative, and a clock that ticks mid-list would reorder nothing
  // but rewrite every row. Frozen when the dialog opens.
  const [openedAtMs, setOpenedAtMs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  // `environments` is rebuilt each render by its hook, so the catalog is read
  // through a ref rather than depended on — the subscription must survive the
  // whole session, not resubscribe on every connection tick.
  const scopeInputsRef = useRef<{
    readonly primaryEnvironmentId: EnvironmentId | null;
    readonly environmentIds: ReadonlyArray<EnvironmentId>;
  }>({ primaryEnvironmentId: null, environmentIds: [] });
  scopeInputsRef.current = {
    primaryEnvironmentId,
    environmentIds: environments.map((environment) => environment.environmentId),
  };

  useEffect(
    () =>
      subscribeImportPicker((detail) => {
        setOpen(true);
        setEnvironmentId(
          resolveImportPickerScope({
            requested: detail.environmentId,
            ...scopeInputsRef.current,
          }),
        );
        setSelectedSessionId(null);
        setFilter("");
        setLimit(IMPORT_PICKER_PAGE_SIZE);
        setPrompt(null);
        setBusy(false);
        setOpenedAtMs(Date.now());
      }),
    [],
  );

  const sessionsQuery = useHistorySessionsPage(
    open && environmentId !== null
      ? // The empty `since` opens the window to the whole index. A picker that
        // only offered the last seven days would hide exactly the session you
        // half-remember and came here to find.
        { environmentId, since: "", limit }
      : null,
  );
  // Deliberately not gated on `open`, unlike the two queries above. The
  // refresh fired after an import has to outlive the dialog that fired it: if
  // this subscription ends when the dialog closes, the in-flight refetch is
  // dropped, the cached page stays stale for its idle TTL, and the thread we
  // just navigated to shows no provenance line. The cost of holding it is one
  // small file read per machine, already paid by any imported thread on screen.
  const importsQuery = useHistoryImports(environmentId);
  const refreshImports = useRefreshHistoryImports(environmentId);

  const rows = useMemo(
    () =>
      buildImportPickerRows({
        sessions: sessionsQuery.data?.sessions ?? [],
        imports: importsQuery.data?.imports ?? null,
        nowMs: openedAtMs,
      }),
    [importsQuery.data, openedAtMs, sessionsQuery.data],
  );
  const visibleRows = useMemo(
    () => rows.filter((row) => matchesImportPickerFilter(row, filter)),
    [filter, rows],
  );
  const selectedRow =
    visibleRows.find((row) => row.sessionId === selectedSessionId) ?? visibleRows[0] ?? null;

  const previewQuery = useHistoryPreview(
    open && environmentId !== null && selectedRow !== null
      ? { environmentId, sessionId: selectedRow.sessionId }
      : null,
  );

  const openThread = useCallback(
    async (targetEnvironmentId: EnvironmentId, threadId: ThreadId) => {
      const threadRef = scopeThreadRef(targetEnvironmentId, threadId);
      // The thread exists on the server the moment import returns, but this
      // client learns about it over the websocket a beat later — and the thread
      // route treats a thread it has never heard of as deleted and bounces to
      // "/". Navigating immediately therefore lands anywhere but the thread we
      // just made. Waiting for the projection to catch up is the whole fix; the
      // timeout only decides whether a wedged connection gets a wrong-looking
      // route or an indefinite spinner.
      await waitForThreadShell(threadRef);
      setOpen(false);
      // The chat view focuses its composer whenever the active thread changes,
      // so arriving here is arriving with the cursor already blinking — which
      // is the point of the whole feature.
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );

  const resume = useCallback(
    async (createProject: boolean) => {
      if (environmentId === null || selectedRow === null || busy) return;
      if (selectedRow.importedThreadId !== null) {
        await openThread(environmentId, selectedRow.importedThreadId);
        return;
      }
      setBusy(true);
      setPrompt(null);
      const attempt = await runImport({
        environmentId,
        sessionId: selectedRow.sessionId,
        request: createProject ? { createProject: true } : {},
      });
      setBusy(false);
      const outcome = resolveImportAttempt(attempt);
      if (outcome.kind !== "openThread") {
        setPrompt(outcome.prompt);
        return;
      }
      // The registry we just changed is cached per machine and never polled —
      // a session file does not change on its own, but this one just did,
      // because we wrote it. Without this the thread opens with no provenance
      // line until the cache expires, which is the exact surprise the line
      // exists to prevent. Refreshed before the dialog closes, while this hook
      // still holds the real atom rather than the null one.
      refreshImports();
      await openThread(environmentId, outcome.threadId);
    },
    [busy, environmentId, openThread, refreshImports, runImport, selectedRow],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (visibleRows.length === 0) return;
      const current = visibleRows.findIndex((row) => row.sessionId === selectedRow?.sessionId);
      const next = Math.min(Math.max(current + delta, 0), visibleRows.length - 1);
      const row = visibleRows[next];
      if (row !== undefined) setSelectedSessionId(row.sessionId);
    },
    [selectedRow, visibleRows],
  );

  const totalAvailable = sessionsQuery.data?.totalAvailable ?? 0;
  const canLoadOlder = rows.length < totalAvailable && limit < IMPORT_PICKER_MAX_SESSIONS;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup
        className="h-[min(78vh,42rem)] max-w-5xl gap-0 p-0"
        data-testid="import-conversation-dialog"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveSelection(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(-1);
          }
        }}
      >
        <header className="flex shrink-0 flex-col gap-1 border-b border-border/60 px-5 py-4">
          <h2 className="text-sm font-medium text-foreground">Import a conversation</h2>
          <p className="text-xs text-muted-foreground">
            Pick a Claude Code or Codex session from this machine and carry on with it here — the
            model keeps everything it remembers.
          </p>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 w-[22rem] shrink-0 flex-col border-r border-border/60">
            {environments.length > 1 ? (
              <div className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2">
                {environments.map((environment) => (
                  <button
                    key={environment.environmentId}
                    type="button"
                    data-testid="import-picker-machine"
                    onClick={() => {
                      setEnvironmentId(environment.environmentId);
                      setSelectedSessionId(null);
                      setPrompt(null);
                      setLimit(IMPORT_PICKER_PAGE_SIZE);
                    }}
                    className={cn(
                      "cursor-pointer rounded-md px-2 py-1 text-[11px] transition-colors",
                      environment.environmentId === environmentId
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {environment.label}
                    {environment.isOwnBackend ? (
                      // Two connections on one laptop announce the same machine
                      // name — the app's embedded server and the hub it is
                      // paired with. Picking the wrong one lands the resumed
                      // thread somewhere no other client can ever see it.
                      <span
                        data-testid="import-picker-own-backend"
                        className="ml-1 text-[10px] text-muted-foreground/60"
                      >
                        · this app
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="px-3 py-2">
              <Input
                value={filter}
                autoFocus
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search titles, projects…"
                className="h-8 text-xs"
                data-testid="import-picker-filter"
              />
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div ref={listRef} className="flex flex-col gap-0.5 px-2 pb-3">
                {sessionsQuery.isPending && rows.length === 0 ? (
                  <div className="flex items-center gap-2 px-2 py-6 text-xs text-muted-foreground">
                    <Spinner className="size-3" />
                    Reading this machine&rsquo;s sessions…
                  </div>
                ) : null}
                {!sessionsQuery.isPending && visibleRows.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground/70">
                    {rows.length === 0
                      ? "No Claude Code or Codex sessions found on this machine."
                      : "Nothing matches that search."}
                  </p>
                ) : null}
                {visibleRows.map((row) => (
                  <ImportPickerRow
                    key={row.sessionId}
                    row={row}
                    selected={row.sessionId === selectedRow?.sessionId}
                    onSelect={() => {
                      setSelectedSessionId(row.sessionId);
                      setPrompt(null);
                    }}
                  />
                ))}
                {canLoadOlder ? (
                  <button
                    type="button"
                    onClick={() =>
                      setLimit((value) =>
                        Math.min(value + IMPORT_PICKER_PAGE_SIZE, IMPORT_PICKER_MAX_SESSIONS),
                      )
                    }
                    className="mt-1 flex h-[30px] w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:text-foreground dark:border-white/15 dark:hover:border-white/30"
                  >
                    Load older
                    <span className="text-muted-foreground/50">({totalAvailable} in all)</span>
                  </button>
                ) : null}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {selectedRow === null ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground/60">
                Select a conversation to see where it got to.
              </div>
            ) : (
              <ImportPreviewPane
                key={selectedRow.sessionId}
                row={selectedRow}
                preview={previewQuery.data}
                isPending={previewQuery.isPending}
                machineLabel={
                  environments.find((environment) => environment.environmentId === environmentId)
                    ?.label ?? null
                }
              />
            )}
            <footer className="shrink-0 border-t border-border/60 px-5 py-3">
              {prompt?.kind === "error" ? (
                <p
                  data-testid="import-picker-error"
                  className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {prompt.message}
                </p>
              ) : null}
              {prompt?.kind === "needsProject" ? (
                <div
                  data-testid="import-picker-needs-project"
                  className="mb-2 space-y-1 text-xs text-muted-foreground"
                >
                  <p>
                    starcode isn't set up to run threads in{" "}
                    <span className="font-mono text-foreground">{prompt.cwd}</span> on this machine
                    yet. Register it and resume there?{" "}
                    <span className="text-muted-foreground/70">
                      Nothing is copied — the conversation continues in place.
                    </span>
                  </p>
                  {/* The trap this line exists for: on the desktop app the
                      embedded backend has no folders registered at all, so it
                      always offers to register one — while the hub paired on
                      the same laptop already has that exact folder. Taking the
                      offer puts the thread somewhere only this app can see. */}
                  {folderElsewhere === null ? null : (
                    <p data-testid="import-picker-folder-elsewhere" className="text-warning">
                      <span className="font-medium">{folderElsewhere.label}</span> already has this
                      folder.{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setEnvironmentId(folderElsewhere.environmentId);
                          setSelectedSessionId(null);
                          setPrompt(null);
                          setLimit(IMPORT_PICKER_PAGE_SIZE);
                        }}
                        className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                      >
                        Resume there instead
                      </button>
                    </p>
                  )}
                </div>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={selectedRow === null || busy}
                  data-testid="import-picker-resume"
                  onClick={() => void resume(prompt?.kind === "needsProject")}
                >
                  {busy ? <Spinner className="size-3" /> : <DownloadIcon className="size-3" />}
                  {selectedRow?.importedThreadId != null
                    ? "Open thread"
                    : prompt?.kind === "needsProject"
                      ? "Register folder and resume"
                      : "Resume in starcode"}
                </Button>
              </div>
            </footer>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ImportPickerRow(props: {
  readonly row: ImportPickerRowModel;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const { row } = props;
  return (
    <button
      type="button"
      onClick={props.onSelect}
      data-testid="import-picker-row"
      data-session-id={row.sessionId}
      data-selected={props.selected ? "true" : "false"}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
        props.selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <HistoryProviderIcon provider={row.provider} className="size-3 shrink-0 opacity-70" />
        <span
          data-derived-title={row.titleIsDerived ? "true" : "false"}
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            // A guessed title is rendered as a guess. The picker exists
            // because titles sometimes lie; dressing a derivation up as a real
            // one would be the feature arguing against itself.
            row.titleIsDerived
              ? "italic text-muted-foreground"
              : "font-medium text-sidebar-foreground",
          )}
        >
          {row.title}
        </span>
        {row.importedThreadId !== null ? (
          <span
            data-testid="import-picker-imported-badge"
            className="shrink-0 rounded-sm bg-muted px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground"
          >
            Imported
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{row.age}</span>
      </span>
      {row.snippet !== null && row.snippet !== row.title ? (
        <span className="truncate text-[11px] text-muted-foreground/70">{row.snippet}</span>
      ) : null}
      {row.projectLabel !== null ? (
        <span className="truncate text-[10px] text-muted-foreground/50">{row.projectLabel}</span>
      ) : null}
    </button>
  );
}

function ImportPreviewPane(props: {
  readonly row: ImportPickerRowModel;
  readonly preview: ReturnType<typeof useHistoryPreview>["data"];
  readonly isPending: boolean;
  readonly machineLabel: string | null;
}): ReactNode {
  const { preview } = props;
  const timeline = useMemo(() => buildImportPreviewTimeline(preview), [preview]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Land on the newest message, and stay there while the content is still
  // settling: markdown resolves its code highlighting asynchronously, so a
  // single scroll on mount aims at a container that is about to grow and
  // leaves the newest message hundreds of pixels below the fold. Pinning on
  // resize is what makes this behave like a thread scrolled to its end.
  // Released the moment the reader scrolls for themselves.
  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    let pinned = true;
    const release = () => {
      pinned = false;
    };
    const pin = () => {
      if (pinned) bottomRef.current?.scrollIntoView({ block: "end" });
    };
    pin();
    // The observer catches content that grows late (code highlighting), but
    // not content that was already complete before it started observing and
    // only settled its layout afterwards — hence the frames as well. Both are
    // cheap and idempotent, and both stop at the first scroll by hand.
    const frame = window.requestAnimationFrame(() => {
      pin();
      window.requestAnimationFrame(pin);
    });
    const settle = window.setTimeout(pin, 250);
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    content.addEventListener("wheel", release, { passive: true });
    content.addEventListener("touchmove", release, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      observer.disconnect();
      content.removeEventListener("wheel", release);
      content.removeEventListener("touchmove", release);
    };
  }, [timeline]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/60 px-5 py-3">
        <p
          className={cn(
            "truncate text-sm",
            props.row.titleIsDerived ? "italic text-muted-foreground" : "text-foreground",
          )}
        >
          {props.row.title}
        </p>
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
          {props.row.projectPath ?? "Working directory unknown"}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/60">
          {historyProviderLabel(props.row.provider)}
          {props.machineLabel === null ? "" : ` · ${props.machineLabel}`}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {/* `justify-end` on a full-height column is what bottom-anchors this:
            a short conversation sits against the composer edge instead of
            floating at the top, which is how a thread you have scrolled to the
            end of actually looks. */}
        <div
          ref={contentRef}
          className="flex min-h-full flex-col justify-end gap-3 px-5 py-4"
          data-testid="import-picker-preview"
        >
          {props.isPending && preview === null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Reading the conversation…
            </div>
          ) : null}
          {!props.isPending && preview === null ? (
            <p className="text-xs text-muted-foreground/70">
              This machine cannot show a preview. Importing still works.
            </p>
          ) : null}
          {timeline.caption !== null ? (
            <p
              data-testid="import-picker-preview-caption"
              className="truncate text-[11px] text-muted-foreground/60"
            >
              <span className="text-muted-foreground/45">Started with: </span>
              {timeline.caption}
            </p>
          ) : null}
          {timeline.showBreak ? (
            <div aria-hidden className="flex select-none items-center gap-2 py-0.5">
              <span className="h-px flex-1 bg-border/60" />
              <span className="text-[10px] tracking-[0.35em] text-muted-foreground/40">···</span>
              <span className="h-px flex-1 bg-border/60" />
            </div>
          ) : null}
          {timeline.entries.map((entry) => (
            <HistoryMessage key={entry.offset} entry={entry} cwd={props.row.projectPath} />
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
