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

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/** Transcript entries per page when the caller names no limit. */
export const HISTORY_TRANSCRIPT_DEFAULT_LIMIT = 80;
/** Hard ceiling on a transcript page. */
export const HISTORY_TRANSCRIPT_MAX_LIMIT = 300;
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
 * A window of a session, newest last.
 *
 * The first page is the *tail* — the newest entries — because that is what a
 * reader wants first and what can be produced without touching the front of a
 * 38 MB file. `nextBefore` walks backwards from there.
 */
export const HistoryTranscriptPage = Schema.Struct({
  session: HistorySessionSummary,
  /** Ascending by offset: oldest first within the page, newest at the bottom. */
  entries: Schema.Array(HistoryTranscriptEntry),
  /** Older records exist before the first returned entry. */
  hasMore: Schema.Boolean,
  /**
   * Pass as `before` for the next page back. This is the offset of the oldest
   * line *examined*, not the oldest line rendered, so records the renderer
   * skipped are not rescanned on the following page.
   */
  nextBefore: Schema.NullOr(NonNegativeInt),
});
export type HistoryTranscriptPage = typeof HistoryTranscriptPage.Type;
