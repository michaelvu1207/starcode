/**
 * Terminal history - read-only previews of CLI sessions on a machine's disk.
 *
 * This is a *reader*, not an importer. Claude Code and Codex each keep their
 * own append-only jsonl session logs under the user's home directory; this
 * contract exposes them as paginated, lossy previews so the hub can show what
 * a machine has been doing outside t3 without copying any of it into t3's
 * database. Nothing here is persisted server-side: the index is in memory and
 * the transcript is read straight off the file on demand.
 *
 * Two properties drive the shapes below.
 *
 * **Session ids are opaque.** A `HistorySessionId` is a hash of the absolute
 * file path, minted by the server and resolvable only through the server's own
 * index. The client never sees, sends, or influences a path — that is the only
 * thing standing between this feature and an arbitrary-file-read endpoint, so
 * the id is pattern-constrained to hex here as well as validated there.
 *
 * **Transcript cursors are byte offsets.** Entries are addressed by the byte
 * offset of their line in the file, which is stable for an append-only log and
 * is the only cursor that lets the newest page be served by reading backwards
 * from the end instead of parsing megabytes of history first.
 *
 * @module History
 */
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Days of history a listing covers when the caller names no window. */
export const HISTORY_SESSIONS_DEFAULT_WINDOW_DAYS = 7;
/** Sessions per listing page when the caller names no limit. */
export const HISTORY_SESSIONS_DEFAULT_LIMIT = 40;
/**
 * Hard ceiling on a listing page. Each returned row costs one head-read of its
 * file to produce a snippet, so this bounds the disk work one request can ask
 * for, not just the response size.
 */
export const HISTORY_SESSIONS_MAX_LIMIT = 200;

/**
 * Entries in a preview's tail.
 *
 * Bounded, with no cursor and no load-more, because the preview answers one
 * question — *which conversation is this?* — and the reader that used to
 * answer "what did it say?" is gone. A mistitled session is identified by how
 * it opened and where it ended up, so the preview is the opening message plus
 * this many closing ones. Deeper and we have rebuilt the viewer we deleted.
 */
export const HISTORY_PREVIEW_TAIL_ENTRIES = 8;
/**
 * Per-entry text budget, matching the peer transcript renderer. Long tool
 * output and pasted files are clipped rather than streamed: this is a preview.
 */
export const HISTORY_TRANSCRIPT_ENTRY_MAX_CHARS = 4_000;
/** Per-entry tool-call name budget. Tool payloads are never rendered at all. */
export const HISTORY_TRANSCRIPT_MAX_TOOL_CALLS = 12;
/** Snippet budget for a listing row. */
export const HISTORY_SNIPPET_MAX_CHARS = 240;

/**
 * Entries in one page of an imported thread's earlier conversation.
 *
 * Larger than a preview and smaller than a chapter. This backs a section a
 * reader scrolls up through to find what the model already knows, so a page
 * has to be worth the round trip without being worth a spinner.
 */
export const HISTORY_PAGE_DEFAULT_ENTRIES = 30;
/**
 * Ceiling on a page. Each entry costs a parse and up to
 * `HISTORY_TRANSCRIPT_ENTRY_MAX_CHARS`, and the backwards reader's byte budget
 * will cut a page short long before this on the sessions that matter — so this
 * bounds the response, and the byte budget bounds the disk work.
 */
export const HISTORY_PAGE_MAX_ENTRIES = 100;

/**
 * Which CLI wrote the session. Not `ProviderDriverKind`: these are on-disk
 * stores belonging to the CLIs themselves, discovered by path, with no
 * relationship to the provider instances this server has configured.
 */
export const HistoryProvider = Schema.Literals(["claude", "codex"]);
export type HistoryProvider = typeof HistoryProvider.Type;

/**
 * Opaque handle for one session file.
 *
 * The pattern is load-bearing, not cosmetic. It is the outermost of the two
 * checks that keep a client from naming a file: anything path-shaped fails to
 * decode here before the server's index is ever consulted.
 */
export const HistorySessionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{32}$/),
).pipe(Schema.brand("HistorySessionId"));
export type HistorySessionId = typeof HistorySessionId.Type;

/**
 * Listing cursor. Opaque to the client, `<lastActivityMs>.<sessionId>` to the
 * server — the same (timestamp, id) pair the listing sorts on, so a page
 * boundary at a shared mtime neither drops nor repeats a session.
 */
export const HistorySessionsCursor = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type HistorySessionsCursor = typeof HistorySessionsCursor.Type;

/**
 * Where a session's displayed title came from.
 *
 * Carried so the client can render a derived title as derived. Only `session`
 * is a real title the CLI wrote for itself; the other two are this server
 * guessing, and a guess that looks authoritative is worse than one that looks
 * like a guess — especially here, where the entire feature exists because
 * titles sometimes lie.
 */
export const HistoryTitleSource = Schema.Literals([
  /** Claude's own `ai-title` record. Present on roughly 40% of sessions, never on Codex. */
  "session",
  /** Derived from the first thing a human typed. */
  "message",
  /** Last resort: the directory the session ran in. */
  "project",
]);
export type HistoryTitleSource = typeof HistoryTitleSource.Type;

/**
 * One session as the listing sees it. Everything here is either free from a
 * `stat` or comes from a bounded head-read of the file; nothing requires
 * parsing the session through to the end.
 */
export const HistorySessionSummary = Schema.Struct({
  id: HistorySessionId,
  provider: HistoryProvider,
  /**
   * The working directory the session ran in, read from the session's own
   * records where they carry it. Null when the head-read found none — for
   * Claude that is rare, for Codex it means the file has no `session_meta`.
   */
  projectPath: Schema.NullOr(TrimmedNonEmptyString),
  /** Last path segment of `projectPath`, for a row that has no room for the rest. */
  projectLabel: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The session's first real user message, clipped. Null when the head-read
   * budget ran out before one appeared, which happens on Codex sessions whose
   * preamble is unusually large.
   */
  snippet: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Best available name for the session. Null only when the file yielded
   * nothing at all — no title record, no user message, no working directory.
   */
  title: Schema.NullOr(TrimmedNonEmptyString),
  /** Which rung of the fallback chain `title` came from. Null when it did. */
  titleSource: Schema.NullOr(HistoryTitleSource),
  /** File mtime: when the CLI last wrote to this session. */
  lastActivityAt: IsoDateTime,
  sizeBytes: NonNegativeInt,
});
export type HistorySessionSummary = typeof HistorySessionSummary.Type;

export const HistorySessionsPage = Schema.Struct({
  sessions: Schema.Array(HistorySessionSummary),
  /** Pass as `cursor` to fetch the page immediately older than this one. */
  nextCursor: Schema.NullOr(HistorySessionsCursor),
  /**
   * Sessions in the whole index, ignoring the requested window. This is what
   * lets the client offer "show older (N)" without a second round trip.
   */
  totalAvailable: NonNegativeInt,
  /** Sessions matching the requested window, before the cursor was applied. */
  totalInWindow: NonNegativeInt,
  /** Lower bound actually applied, so the client can label the window it got. */
  since: Schema.NullOr(IsoDateTime),
  /** When the index this page was served from last revalidated. */
  indexedAt: IsoDateTime,
});
export type HistorySessionsPage = typeof HistorySessionsPage.Type;

/**
 * One rendered line of a session.
 *
 * `offset` is the byte position of the record's line in the file. It is the
 * paging cursor and it is stable, because these logs are only ever appended to.
 */
export const HistoryTranscriptEntry = Schema.Struct({
  offset: NonNegativeInt,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  /** True when `text` was clipped to the per-entry budget. */
  truncated: Schema.Boolean,
  /** Tool-call names in this record. Payloads are never included. */
  toolCalls: Schema.Array(TrimmedNonEmptyString),
  timestamp: Schema.NullOr(IsoDateTime),
});
export type HistoryTranscriptEntry = typeof HistoryTranscriptEntry.Type;

/**
 * Enough of a session to recognise it, and no more.
 *
 * Two disjoint slices rather than one list, because they are read from
 * opposite ends of the file and the space between them is not something this
 * endpoint will ever fetch. `gap` says whether anything sits in that space, so
 * the client can mark the elision honestly instead of implying the session is
 * nine messages long.
 */
export const HistoryPreview = Schema.Struct({
  session: HistorySessionSummary,
  /**
   * The first thing a human typed. Null when the opening already appears in
   * `tail` (a short session), or when the head read found no human turn.
   */
  opening: Schema.NullOr(HistoryTranscriptEntry),
  /** The closing entries, ascending by offset: oldest first, newest last. */
  tail: Schema.Array(HistoryTranscriptEntry),
  /** True when entries exist between `opening` and the first of `tail`. */
  gap: Schema.Boolean,
});
export type HistoryPreview = typeof HistoryPreview.Type;

/**
 * One page of a session, newest first.
 *
 * The preview above is bounded and cursorless because it answers a question a
 * bounded answer settles. This one has a cursor because it answers a different
 * question — what an imported thread's model already knows — and that question
 * has as many messages behind it as the session does.
 *
 * The cursor still only ever runs *backwards*. A reader opens at the end of a
 * conversation and works up, which is also the only direction a 38 MB
 * append-only log can be read cheaply, so "newest page, then earlier" is both
 * the natural reading order and the only affordable one.
 */
export const HistoryTranscriptPage = Schema.Struct({
  /** Ascending by offset: oldest first, newest last. */
  entries: Schema.Array(HistoryTranscriptEntry),
  /**
   * Pass as `before` to fetch the page immediately earlier. Null when this
   * page reached the top of the session, which is what ends "show earlier".
   *
   * Not simply the first entry's offset: it is the oldest byte the scan
   * *looked at*, so a long run of records that render to nothing is walked
   * past once rather than re-scanned by every later page.
   */
  nextBefore: Schema.NullOr(NonNegativeInt),
});
export type HistoryTranscriptPage = typeof HistoryTranscriptPage.Type;

/**
 * Import: turning one of those on-disk sessions into a real starcode thread.
 *
 * The rest of this module is a reader. This part is not — it is the one place
 * the CLIs' own stores cross into t3's write model, and it does so without
 * copying a single message. What gets written is a thread and a resume
 * binding; the transcript stays where the CLI put it, and the *model's* memory
 * of it comes back on the imported thread's first turn because the provider is
 * asked to resume the original session rather than start a new one.
 *
 * That mechanism is why the failure modes below are refusals rather than
 * best-effort attempts. Claude resolves `--resume <id>` relative to the
 * session's own project directory, and Codex silently degrades an unknown
 * thread id into a brand-new empty thread — so an import that guesses wrong
 * does not error, it produces a thread with amnesia. Every precondition is
 * therefore checked before anything is written.
 */

/** Why an import was refused. Each of these is a precondition, not a hiccup. */
export const HistoryImportRefusalReason = Schema.Literals([
  /** The session file no longer parses into an id and a working directory. */
  "session_unreadable",
  /** The file carries no native session id we could resume (or it is malformed). */
  "session_id_unusable",
  /** The session never recorded the directory it ran in, so no project can match it. */
  "session_cwd_unknown",
  /** No such provider instance is configured on this machine. */
  "instance_not_found",
  /** The named instance is configured but disabled. */
  "instance_disabled",
  /** The instance runs a driver that cannot resume this kind of session. */
  "instance_driver_mismatch",
  /**
   * The instance's home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) does not contain
   * this session, so resuming through it would find nothing. This is the
   * refusal that stops a silent empty Codex thread.
   */
  "instance_home_mismatch",
  /** No model could be resolved for the new thread. */
  "model_unavailable",
  /** The caller named a project that does not exist. */
  "project_not_found",
  /** The project exists but is rooted somewhere other than the session's cwd. */
  "project_cwd_mismatch",
  /** Creating the project at the session's cwd failed. */
  "project_create_failed",
  /** Creating the thread failed. */
  "thread_create_failed",
  /** The resume binding could not be written, so the thread would not resume. */
  "binding_write_failed",
]);
export type HistoryImportRefusalReason = typeof HistoryImportRefusalReason.Type;

export class HistoryImportRefusedError extends Schema.TaggedErrorClass<HistoryImportRefusedError>()(
  "HistoryImportRefusedError",
  {
    code: Schema.Literal("history_import_refused"),
    reason: HistoryImportRefusalReason,
    /** Free text for the dialog: which home, which cwd, which driver. */
    detail: Schema.optional(Schema.String),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(HistoryImportRefusedError)(this, { status: 409 });
  }
}

export const HistoryImportRequest = Schema.Struct({
  /**
   * Which configured instance will own the imported thread. Defaults to the
   * built-in instance for the session's provider (`claudeAgent` / `codex`).
   * Whatever it resolves to must own the session's home, or the import is
   * refused rather than started fresh.
   */
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  /**
   * Import into this project instead of matching one by working directory.
   * Refused unless its `workspaceRoot` is the session's cwd — a thread's
   * effective cwd comes from its project, and a mismatch breaks resume.
   */
  projectId: Schema.optionalKey(ProjectId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  title: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * How much the imported thread may do without asking. Absent, it starts in
   * the app-wide default mode, the same as any other new thread — nothing on
   * disk records what permissions the terminal session actually ran with, so
   * there is nothing here to inherit.
   */
  runtimeMode: Schema.optionalKey(RuntimeMode),
  /**
   * Answer to a previous `needs_project` outcome. Absent, an import with no
   * matching project reports what it would create and writes nothing; set,
   * it creates a project at the session's cwd and proceeds.
   */
  createProject: Schema.optionalKey(Schema.Boolean),
});
export type HistoryImportRequest = typeof HistoryImportRequest.Type;

/**
 * The import landed (or had already landed). `alreadyImported` distinguishes
 * the two, and re-importing is deliberately safe: it returns the thread the
 * first import made rather than making a second one bound to the same session.
 */
export const HistoryImportThreadResult = Schema.Struct({
  status: Schema.Literal("imported"),
  alreadyImported: Schema.Boolean,
  threadId: ThreadId,
  projectId: ProjectId,
  /** The session's own working directory, which is also the thread's. */
  cwd: TrimmedNonEmptyString,
  /** The CLI's id for the session — what the provider is asked to resume. */
  nativeSessionId: TrimmedNonEmptyString,
  provider: HistoryProvider,
  providerInstanceId: ProviderInstanceId,
  title: TrimmedNonEmptyString,
  /**
   * Renderable messages in the session behind this thread, and when it began.
   *
   * Both exist for one line of UI: an imported thread opens with an empty
   * transcript that the model nonetheless remembers, which is a genuine
   * surprise, and "Resumed from a Claude terminal session · 483 messages ·
   * Jul 12" is what defuses it. `messageCount` is null when counting hit its
   * byte budget — an honest unknown rather than a low number presented as
   * fact.
   */
  messageCount: Schema.NullOr(NonNegativeInt),
  startedAt: Schema.NullOr(IsoDateTime),
});
export type HistoryImportThreadResult = typeof HistoryImportThreadResult.Type;

/**
 * Nothing was written. No project is rooted at the session's cwd, and creating
 * one across four machines is not something to do silently — the caller is
 * told what would be created and can retry with `createProject`.
 */
export const HistoryImportNeedsProjectResult = Schema.Struct({
  status: Schema.Literal("needs_project"),
  cwd: TrimmedNonEmptyString,
  /** Last path segment of `cwd`: the title the project would get. */
  suggestedProjectTitle: TrimmedNonEmptyString,
  provider: HistoryProvider,
  providerInstanceId: ProviderInstanceId,
  suggestedThreadTitle: TrimmedNonEmptyString,
});
export type HistoryImportNeedsProjectResult = typeof HistoryImportNeedsProjectResult.Type;

export const HistoryImportResult = Schema.Union([
  HistoryImportThreadResult,
  HistoryImportNeedsProjectResult,
]);
export type HistoryImportResult = typeof HistoryImportResult.Type;

/**
 * One line of the import registry: which CLI session became which thread.
 *
 * This is provenance, not state. It exists so the picker can badge a session
 * as already imported and offer to open the thread instead of importing it
 * twice; the resume binding on the thread is the authoritative link.
 */
export const HistoryImportRecord = Schema.Struct({
  /** The opaque, path-derived id — stable only on the machine that minted it. */
  historySessionId: HistorySessionId,
  /** The CLI's own session id, which survives a re-index and a path change. */
  nativeSessionId: TrimmedNonEmptyString,
  provider: HistoryProvider,
  threadId: ThreadId,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  importedAt: IsoDateTime,
  /** Counted once at import; see `HistoryImportThreadResult`. */
  messageCount: Schema.NullOr(NonNegativeInt),
  startedAt: Schema.NullOr(IsoDateTime),
  /**
   * Where the session ended when this thread took it over, in bytes.
   *
   * The boundary between "the conversation this thread inherited" and "the
   * conversation this thread has had". Resuming appends to the CLI's own file,
   * so without a boundary an imported thread's earlier-conversation section
   * would grow to include the turns the thread itself just took — showing
   * every message twice, once as history and once live.
   *
   * Optional because the registry predates it: a row written before this
   * field existed reads its history from the end of the file, which is
   * correct until the thread takes its first turn and harmless after.
   */
  sourceSizeBytes: Schema.optionalKey(NonNegativeInt),
  /**
   * The session's last write at import time. With `startedAt` this is the date
   * range the collapsed history summary shows; alone it is the better of the
   * two, since a session's `startedAt` is null whenever its opening records
   * carry no timestamp.
   */
  lastActivityAt: Schema.optionalKey(IsoDateTime),
});
export type HistoryImportRecord = typeof HistoryImportRecord.Type;

/**
 * One line of the fork registry: which thread was forked into which.
 *
 * A separate shape rather than a nullable-everything union with the import
 * record, because the two answer different questions. An import row says a
 * conversation came from a CLI session on disk; a fork row says it came from
 * another thread here. The provenance line reads differently in each case
 * ("Resumed from a Claude Code terminal session" versus "Forked from
 * <thread>"), and a caller that had to reconstruct which it was holding from
 * which fields happened to be null would get it wrong.
 *
 * Like the import registry this is provenance, not state: the authoritative
 * link is the fork marker on the new thread's resume cursor, which is what
 * makes the provider fork rather than start fresh.
 */
export const HistoryForkRecord = Schema.Struct({
  /** The fork. */
  threadId: ThreadId,
  /** The thread it was forked from — which may itself no longer exist. */
  sourceThreadId: ThreadId,
  /** The source thread's title when the fork was taken, for a line that reads as a sentence. */
  sourceTitle: Schema.NullOr(TrimmedNonEmptyString),
  /** The provider session the fork resumes from. */
  sourceSessionId: TrimmedNonEmptyString,
  provider: HistoryProvider,
  projectId: ProjectId,
  forkedAt: IsoDateTime,
  /**
   * The source session's file, as this machine's index knew it at fork time.
   *
   * Null when the fork could not be matched to a file on disk — a session
   * whose store has been pruned, or one the index has not discovered — in
   * which case the fork still works (it resumes through the provider, not
   * through this) and only its earlier-conversation section is unavailable.
   */
  historySessionId: Schema.NullOr(HistorySessionId),
  /** Byte boundary, with the same meaning it has on an import row. */
  sourceSizeBytes: Schema.optionalKey(NonNegativeInt),
  /** When the source session began, from a bounded read of its opening. */
  startedAt: Schema.NullOr(IsoDateTime),
  /** The source session's last write at fork time. */
  lastActivityAt: Schema.optionalKey(IsoDateTime),
});
export type HistoryForkRecord = typeof HistoryForkRecord.Type;

export const HistoryImportsPage = Schema.Struct({
  /** The whole registry. It is one row per import and never paginated. */
  imports: Schema.Array(HistoryImportRecord),
  /**
   * Forks taken on this machine, served alongside the imports because both
   * answer one question — *where did this thread's conversation come from?* —
   * and a thread view that had to ask twice would render its provenance a
   * frame late.
   *
   * Optional so that a machine running a server from before forks were
   * recorded still decodes: absent reads as "this machine cannot say", which
   * renders as no provenance rather than as "this thread was not forked".
   */
  forks: Schema.optionalKey(Schema.Array(HistoryForkRecord)),
});
export type HistoryImportsPage = typeof HistoryImportsPage.Type;

/**
 * Forking a thread's conversation.
 *
 * The import above binds a *new* thread to a session the CLI already has on
 * disk. This binds a new thread to the session a *running t3 thread* is
 * already using — the same seam, reached from the other side, and addressed by
 * thread id rather than by session id.
 *
 * Addressed by thread id deliberately, and it is the whole reason this is a
 * route rather than a client-side call. A `HistorySessionId` is a hash of a
 * file path with no reverse lookup, and the client is never told a thread's
 * native session id (`OrchestrationSession` does not carry one). So the only
 * party that can name the session behind a thread is the server, reading the
 * thread's own resume cursor out of `ProviderSessionDirectory`.
 *
 * **The fork never shares the source's session.** The new thread's cursor
 * carries a marker that makes the provider fork on its first turn — the Agent
 * SDK's `forkSession`, which resumes the transcript and then writes to a *new*
 * session id. Two threads appending to one transcript is the failure this
 * feature exists to avoid, and it is silent when it happens, so the marker is
 * not optional decoration: it is the safety property.
 */
export const HistoryForkRefusalReason = Schema.Literals([
  /** No such thread on this machine, or it has been deleted. */
  "thread_not_found",
  /**
   * The thread runs on a driver with no fork primitive. Codex's app-server
   * offers only `thread/start` and `thread/resume`, and resuming appends to
   * the same rollout — so a "fork" there would be the corruption, not the
   * feature.
   */
  "provider_unsupported",
  /**
   * The thread has never held a session worth resuming — nothing has been said
   * in it yet, or its binding carries no provider session id.
   */
  "no_resumable_session",
  /** Creating the forked thread failed. */
  "thread_create_failed",
  /** The fork binding could not be written, so the fork would start blank. */
  "binding_write_failed",
]);
export type HistoryForkRefusalReason = typeof HistoryForkRefusalReason.Type;

/**
 * Separate from the import refusal, though the shape is identical, because the
 * reasons are disjoint and a caller that switched on a merged set would have
 * to handle cases its endpoint can never return.
 */
export class HistoryForkRefusedError extends Schema.TaggedErrorClass<HistoryForkRefusedError>()(
  "HistoryForkRefusedError",
  {
    code: Schema.Literal("history_fork_refused"),
    reason: HistoryForkRefusalReason,
    /** Free text for the caller: which driver, which thread. */
    detail: Schema.optional(Schema.String),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(HistoryForkRefusedError)(this, { status: 409 });
  }
}

export const HistoryForkRequest = Schema.Struct({
  /**
   * What to call the fork. Absent, the server names it after the source — the
   * client has the source's title on screen and the server has it in the
   * projection, so neither needs to guess.
   */
  title: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HistoryForkRequest = typeof HistoryForkRequest.Type;

export const HistoryForkResult = Schema.Struct({
  /** The fork. Empty of turns, and already bound to its own session-to-be. */
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  provider: HistoryProvider,
  /**
   * The session the fork will resume *from* on its first turn. Not the session
   * it will end up owning — that id does not exist until the provider forks —
   * which is why this is named for the source rather than for the result.
   */
  sourceSessionId: TrimmedNonEmptyString,
});
export type HistoryForkResult = typeof HistoryForkResult.Type;
