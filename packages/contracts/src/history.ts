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
});
export type HistoryImportRecord = typeof HistoryImportRecord.Type;

export const HistoryImportsPage = Schema.Struct({
  /** The whole registry. It is one row per import and never paginated. */
  imports: Schema.Array(HistoryImportRecord),
});
export type HistoryImportsPage = typeof HistoryImportsPage.Type;
