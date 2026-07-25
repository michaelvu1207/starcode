// @effect-diagnostics nodeBuiltinImport:off - reads the CLIs' own on-disk session
// stores directly; Effect's FileSystem service has no backwards-read primitive.
/**
 * Terminal history - reading a session file from the end.
 *
 * The whole reason this module exists: the largest session in the local store
 * is 38 MB, and a reader opening it wants the last twenty messages. Parsing
 * forward to find them costs the entire file. So we read fixed-size chunks
 * *backwards* from the end, split them into lines, and stop as soon as enough
 * records have rendered — which for a tail page touches a few hundred KB no
 * matter how large the file is.
 *
 * Line offsets are byte positions, which are stable because both CLIs only
 * ever append. That is what makes them usable as a paging cursor.
 *
 * @module HistoryTailReader
 */
import * as NodeFSP from "node:fs/promises";

import { type HistoryProvider, type HistoryTranscriptEntry } from "@t3tools/contracts";

import {
  isDefinitelyUnrenderable,
  parseRecord,
  readCompactedFirstUserMessage,
  readRecordAiTitle,
  renderRecord,
  SessionHeadFold,
  type SessionHeadFacts,
  toTranscriptEntry,
} from "./records.ts";

const NEWLINE = 0x0a;

/**
 * Bytes per backwards read. Large enough that a page of ordinary messages
 * lands in one or two reads, small enough that a session whose tail is one
 * enormous tool result does not pull megabytes to render a handful of rows.
 */
export const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * Bytes one transcript page may read before it gives up and returns short.
 *
 * Most sessions never approach this. It exists for the shape the local store
 * actually contains: a 638 MB Codex rollout of 1,409 records, whose longest
 * single line is 6 MB of tool output. Filling an 80-entry page there would
 * mean reading ~36 MB and took 1.4 seconds unbudgeted — well past the point
 * the reader feels instant.
 *
 * Returning fewer entries is the right trade: the page is still correct, it
 * still reports `hasMore` and a cursor, and "load earlier" continues from
 * exactly where it stopped. A fast short page beats a slow full one.
 */
export const TAIL_MAX_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * The ceiling that applies even when the page is still empty.
 *
 * The same 638 MB rollout ends with 204 MB of image records and no text at
 * all, so "keep going until you find something" has to stop somewhere. Past
 * this the page comes back empty but honest — `hasMore` and a cursor — and the
 * viewer offers to load earlier rather than pretending the session is over.
 */
export const TAIL_HARD_MAX_PAGE_BYTES = 48 * 1024 * 1024;

/**
 * Head budget for hydrating a listing row, per provider.
 *
 * Claude writes the first user message within a few KB. Codex writes a
 * `session_meta` carrying tens of KB of base instructions, then a developer
 * preamble and an injected environment context, so its first real user message
 * sits around 60-80 KB in. 192 KB clears every session in the local store with
 * room to spare, and a session that somehow exceeds it degrades to a row with
 * no snippet rather than an unbounded read.
 */
/**
 * Bytes of the front of a file a head read may consume, per provider.
 *
 * Codex's is large and empirically chosen: across 347 rollouts on this machine
 * the first user message sits beyond 80 KB in 87 of them and beyond 128 KB in
 * 23, because the developer preamble, the AGENTS.md injection and the
 * environment context all precede it. At 256 KB only 4 rollouts still miss,
 * and those are the ones the compaction fold and the title chain cover.
 */
export const HEAD_BUDGET_BYTES: Record<HistoryProvider, number> = {
  claude: 64 * 1024,
  codex: 256 * 1024,
};

/**
 * Bytes of the *end* of a file scanned for the session's title.
 *
 * Claude rewrites `ai-title` continuously — the last one landed between 2.5 KB
 * and 27 KB from EOF across every titled session on this machine — so this is
 * an order of magnitude of headroom over what the data needs, and it is still
 * one read.
 */
export const TITLE_TAIL_BUDGET_BYTES = 256 * 1024;

/**
 * Bytes a message count may read before giving up and reporting `null`.
 *
 * Counting is a full forward scan, which is affordable only because it happens
 * once, at import, on one file the operator explicitly chose — never per
 * listing row. The largest session in the local store is 38 MB; past this
 * budget the honest answer is "unknown", not a low number stated as fact.
 */
export const STATS_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * One complete line, held as bytes.
 *
 * Deliberately not decoded yet: a record can be megabytes of base64, and the
 * whole point of `isDefinitelyUnrenderable` is to dismiss those from their
 * opening bytes without ever building the string.
 */
interface OffsetLine {
  readonly offset: number;
  readonly bytes: Buffer;
}

/** Bytes of a record inspected before deciding whether to decode all of it. */
const LINE_HEAD_INSPECT_BYTES = 512;
/** Records longer than this are classified from their head first. */
const LINE_LAZY_DECODE_BYTES = 64 * 1024;

/**
 * Splits a buffer covering `[bufferStart, bufferStart + buffer.length)` into
 * complete lines.
 *
 * `leadingPartial` is the bytes before the buffer's first newline. They are a
 * complete line only when the buffer starts at the beginning of the file;
 * otherwise the line began in a region we have not read yet and the caller
 * carries it into the next, lower, chunk.
 */
const splitLines = (
  buffer: Buffer,
  bufferStart: number,
): { readonly lines: ReadonlyArray<OffsetLine>; readonly leadingPartial: Buffer } => {
  const lines: OffsetLine[] = [];
  let lineStart = buffer.indexOf(NEWLINE);
  const leadingPartial = lineStart === -1 ? buffer : buffer.subarray(0, lineStart);
  if (lineStart === -1) return { lines, leadingPartial };

  lineStart += 1;
  while (lineStart <= buffer.length) {
    const next = buffer.indexOf(NEWLINE, lineStart);
    const end = next === -1 ? buffer.length : next;
    if (end > lineStart) {
      lines.push({ offset: bufferStart + lineStart, bytes: buffer.subarray(lineStart, end) });
    }
    if (next === -1) break;
    lineStart = next + 1;
  }
  return { lines, leadingPartial };
};

export interface SessionTail {
  /** Ascending by offset: oldest first, newest last. */
  readonly entries: ReadonlyArray<HistoryTranscriptEntry>;
  /** Offset of the oldest line examined. Zero means the scan reached the top. */
  readonly oldestExamined: number;
}

/**
 * Reads the newest `limit` renderable entries.
 *
 * There is no cursor and no way to ask for an earlier page: this backs a
 * bounded preview, not a reader. `oldestExamined` is kept only so the caller
 * can tell whether anything sits between the file's opening and this tail —
 * the difference between "a nine-message session" and "nine of four hundred".
 */
export const readSessionTail = async (input: {
  readonly path: string;
  readonly provider: HistoryProvider;
  readonly limit: number;
  /** Overridable so tests can force records to straddle a chunk boundary. */
  readonly chunkBytes?: number;
  readonly maxPageBytes?: number;
  readonly hardMaxPageBytes?: number;
}): Promise<SessionTail> => {
  const chunkBytes = input.chunkBytes ?? TAIL_CHUNK_BYTES;
  const maxPageBytes = input.maxPageBytes ?? TAIL_MAX_PAGE_BYTES;
  const hardMaxPageBytes = Math.max(
    input.hardMaxPageBytes ?? TAIL_HARD_MAX_PAGE_BYTES,
    maxPageBytes,
  );
  const handle = await NodeFSP.open(input.path, "r");
  try {
    const stats = await handle.stat();
    const upperBound = stats.size;

    const collected: HistoryTranscriptEntry[] = [];
    let regionEnd = upperBound;
    let carry: Buffer = Buffer.alloc(0);
    let oldestExamined = upperBound;
    let examinedAnyLine = false;
    let bytesRead = 0;

    // The soft budget ends a page that already has something to show; the hard
    // one ends it regardless. Between them sits the case this is really for: a
    // long run of records that render to nothing, where returning an empty page
    // would be technically correct and useless to read.
    const budgetReached = () =>
      collected.length > 0 ? bytesRead >= maxPageBytes : bytesRead >= hardMaxPageBytes;

    while (regionEnd > 0 && collected.length < input.limit && !budgetReached()) {
      const chunkStart = Math.max(0, regionEnd - chunkBytes);
      const chunk = Buffer.alloc(regionEnd - chunkStart);
      await handle.read(chunk, 0, chunk.length, chunkStart);
      bytesRead += chunk.length;
      // The carry is the head of a line whose tail we already hold, so it
      // belongs immediately after this chunk's bytes.
      const combined = carry.length === 0 ? chunk : Buffer.concat([chunk, carry]);
      const { lines, leadingPartial } = splitLines(combined, chunkStart);

      // At the start of the file there is no earlier region, so what looked
      // like a partial first line is in fact the file's first line.
      const allLines =
        chunkStart === 0 && leadingPartial.length > 0
          ? [{ offset: 0, bytes: leadingPartial }, ...lines]
          : lines;
      carry = chunkStart === 0 ? Buffer.alloc(0) : leadingPartial;

      for (let index = allLines.length - 1; index >= 0; index -= 1) {
        const line = allLines[index];
        if (line === undefined) continue;
        oldestExamined = line.offset;
        examinedAnyLine = true;
        const parsed = parseLine(input.provider, line);
        if (parsed !== null) collected.push(parsed);
        if (collected.length >= input.limit) break;
      }
      if (collected.length >= input.limit) break;
      regionEnd = chunkStart;
      if (chunkStart === 0) {
        oldestExamined = 0;
      } else if (!examinedAnyLine && bytesRead >= hardMaxPageBytes) {
        // A single record longer than the whole budget. Without this the next
        // page would read the same bytes forever, so we step the cursor down
        // to where we stopped and let paging walk past the record instead.
        oldestExamined = chunkStart;
      }
    }

    return { entries: collected.toReversed(), oldestExamined };
  } finally {
    await handle.close();
  }
};

const parseLine = (provider: HistoryProvider, line: OffsetLine): HistoryTranscriptEntry | null => {
  if (line.bytes.length > LINE_LAZY_DECODE_BYTES) {
    const head = line.bytes.subarray(0, LINE_HEAD_INSPECT_BYTES).toString("utf8");
    if (isDefinitelyUnrenderable(provider, head)) return null;
  }
  const record = parseRecord(line.bytes.toString("utf8"));
  if (record === null) return null;
  const rendered = renderRecord(provider, record);
  return rendered === null ? null : toTranscriptEntry(line.offset, rendered);
};

/**
 * Reads the front of a session for the two fields a listing row needs.
 *
 * Stops at the first line that completes both, or at the provider's byte
 * budget, whichever comes first. A session that yields none of them still
 * produces a row — with a null project, no snippet and no title — because a
 * session you cannot summarise is still a session you should be able to
 * import.
 */
export const readSessionHead = async (input: {
  readonly path: string;
  readonly provider: HistoryProvider;
}): Promise<SessionHeadFacts> => foldSessionHead(input, new SessionHeadFold(input.provider));

/**
 * Anything that can be fed a session's opening lines and say when it has seen
 * enough. `push` returns true to stop the scan early.
 */
export interface SessionHeadConsumer<Result> {
  push: (line: string) => boolean;
  readonly complete: boolean;
  readonly result: Result;
}

/**
 * Streams the front of a session file through a fold, bounded by the
 * provider's head budget.
 *
 * Shared rather than duplicated because the budget is the interesting part:
 * Codex's preamble runs to ~80 KB before the first real message, and getting
 * that number wrong means either a listing row with no snippet or an import
 * that reads a megabyte to find one line.
 */
export const foldSessionHead = async <Result>(
  input: {
    readonly path: string;
    readonly provider: HistoryProvider;
  },
  fold: SessionHeadConsumer<Result>,
): Promise<Result> => {
  const budget = HEAD_BUDGET_BYTES[input.provider];
  const handle = await NodeFSP.open(input.path, "r");
  try {
    let position = 0;
    let carry = "";
    while (position < budget) {
      const chunk = Buffer.alloc(Math.min(TAIL_CHUNK_BYTES, budget - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = carry + chunk.subarray(0, bytesRead).toString("utf8");
      const pieces = text.split("\n");
      // The last piece has no terminating newline yet; it may continue into
      // the next read.
      carry = pieces.pop() ?? "";
      let done = false;
      for (const piece of pieces) {
        if (fold.push(piece)) {
          done = true;
          break;
        }
      }
      if (done || bytesRead < chunk.length) break;
    }
    if (!fold.complete && carry.length > 0) fold.push(carry);
    return fold.result;
  } finally {
    await handle.close();
  }
};

/**
 * Scans the end of a Claude session for the title it last gave itself.
 *
 * Backwards, and stopping at the first hit, because the *last* `ai-title`
 * record in the file is the current one — earlier ones are stale guesses the
 * CLI revised. Bounded by `TITLE_TAIL_BUDGET_BYTES`: a session whose titles
 * all sit further back than that reports none, and the caller falls through to
 * the next rung of the chain rather than reading a 38 MB file to name a row.
 *
 * Codex never writes titles, so callers skip this for Codex rather than paying
 * a read to learn nothing.
 */
export const readSessionTitleTail = async (input: {
  readonly path: string;
  readonly chunkBytes?: number;
  readonly budgetBytes?: number;
}): Promise<string | null> => {
  const chunkBytes = input.chunkBytes ?? TAIL_CHUNK_BYTES;
  const budgetBytes = input.budgetBytes ?? TITLE_TAIL_BUDGET_BYTES;
  const handle = await NodeFSP.open(input.path, "r");
  try {
    const stats = await handle.stat();
    let regionEnd = stats.size;
    let carry: Buffer = Buffer.alloc(0);
    let bytesRead = 0;

    while (regionEnd > 0 && bytesRead < budgetBytes) {
      const chunkStart = Math.max(0, regionEnd - chunkBytes);
      const chunk = Buffer.alloc(regionEnd - chunkStart);
      await handle.read(chunk, 0, chunk.length, chunkStart);
      bytesRead += chunk.length;
      const combined = carry.length === 0 ? chunk : Buffer.concat([chunk, carry]);
      const { lines, leadingPartial } = splitLines(combined, chunkStart);
      const allLines =
        chunkStart === 0 && leadingPartial.length > 0
          ? [{ offset: 0, bytes: leadingPartial }, ...lines]
          : lines;
      carry = chunkStart === 0 ? Buffer.alloc(0) : leadingPartial;

      for (let index = allLines.length - 1; index >= 0; index -= 1) {
        const line = allLines[index];
        if (line === undefined) continue;
        // Cheap byte test first: the overwhelming majority of records in a
        // session are not titles, and decoding a megabyte of tool output to
        // discover that would defeat the point of a bounded scan.
        if (!line.bytes.includes(AI_TITLE_MARKER)) continue;
        const record = parseRecord(line.bytes.toString("utf8"));
        if (record === null) continue;
        const title = readRecordAiTitle(record);
        if (title !== null) return title;
      }
      regionEnd = chunkStart;
    }
    return null;
  } finally {
    await handle.close();
  }
};

const AI_TITLE_MARKER = Buffer.from('"ai-title"', "utf8");

export interface SessionStats {
  /** Renderable messages, or null when the scan hit its byte budget. */
  readonly messageCount: number | null;
  /** Timestamp of the first record that carried one. */
  readonly startedAt: string | null;
}

/**
 * Counts a session's messages and finds when it began.
 *
 * A full forward scan, deliberately: there is no cheaper honest way. Line
 * count over-reports wildly (every tool result is its own record), and the
 * index's `stat` knows nothing about contents. This runs once per import, on a
 * file the operator explicitly chose, and reports `null` rather than a partial
 * count if the file is larger than the budget.
 */
export const readSessionStats = async (input: {
  readonly path: string;
  readonly provider: HistoryProvider;
  readonly chunkBytes?: number;
  readonly budgetBytes?: number;
}): Promise<SessionStats> => {
  const chunkBytes = input.chunkBytes ?? TAIL_CHUNK_BYTES;
  const budgetBytes = input.budgetBytes ?? STATS_BUDGET_BYTES;
  const handle = await NodeFSP.open(input.path, "r");
  try {
    const stats = await handle.stat();
    let position = 0;
    let carry = "";
    let messageCount = 0;
    let startedAt: string | null = null;

    while (position < stats.size) {
      if (position >= budgetBytes) return { messageCount: null, startedAt };
      const chunk = Buffer.alloc(Math.min(chunkBytes, stats.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = carry + chunk.subarray(0, bytesRead).toString("utf8");
      const pieces = text.split("\n");
      carry = pieces.pop() ?? "";
      for (const piece of pieces) {
        const record = parseRecord(piece);
        if (record === null) continue;
        const rendered = renderRecord(input.provider, record);
        if (rendered === null) continue;
        if (rendered.text.length > 0) messageCount += 1;
        if (startedAt === null && rendered.timestamp !== null) startedAt = rendered.timestamp;
      }
    }
    if (carry.length > 0) {
      const record = parseRecord(carry);
      if (record !== null) {
        const rendered = renderRecord(input.provider, record);
        if (rendered !== null && rendered.text.length > 0) messageCount += 1;
      }
    }
    return { messageCount, startedAt };
  } finally {
    await handle.close();
  }
};

/**
 * Finds the first thing a human typed, with the byte offset that places it.
 *
 * A forward read rather than a reuse of `readSessionHead` because the preview
 * needs the offset — that is what lets the caller tell whether the opening is
 * already inside the tail, and whether anything sits between the two. Bounded
 * by the same head budget, and stops at the first hit.
 *
 * The compaction case is handled here rather than in the renderer: a Codex
 * rollout that has been compacted keeps its original messages inside
 * `compacted.payload.replacement_history`, and without folding those in the
 * preview of a long session opens mid-conversation with nothing to say so.
 */
export const readSessionOpening = async (input: {
  readonly path: string;
  readonly provider: HistoryProvider;
  readonly chunkBytes?: number;
  readonly budgetBytes?: number;
}): Promise<HistoryTranscriptEntry | null> => {
  const chunkBytes = input.chunkBytes ?? TAIL_CHUNK_BYTES;
  const budget = input.budgetBytes ?? HEAD_BUDGET_BYTES[input.provider];
  const handle = await NodeFSP.open(input.path, "r");
  try {
    let position = 0;
    let carry = Buffer.alloc(0);
    let carryOffset = 0;

    while (position < budget) {
      const chunk = Buffer.alloc(Math.min(chunkBytes, budget - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const region = chunk.subarray(0, bytesRead);
      const combined = carry.length === 0 ? region : Buffer.concat([carry, region]);
      const combinedStart = carry.length === 0 ? position : carryOffset;
      position += bytesRead;

      let lineStart = 0;
      while (true) {
        const next = combined.indexOf(NEWLINE, lineStart);
        if (next === -1) break;
        const offset = combinedStart + lineStart;
        const found = renderOpeningLine(input.provider, combined.subarray(lineStart, next), offset);
        if (found !== null) return found;
        lineStart = next + 1;
      }
      carry = combined.subarray(lineStart);
      carryOffset = combinedStart + lineStart;
      if (bytesRead < chunk.length) break;
    }
    return carry.length === 0 ? null : renderOpeningLine(input.provider, carry, carryOffset);
  } finally {
    await handle.close();
  }
};

const renderOpeningLine = (
  provider: HistoryProvider,
  bytes: Buffer,
  offset: number,
): HistoryTranscriptEntry | null => {
  if (bytes.length === 0) return null;
  const record = parseRecord(bytes.toString("utf8"));
  if (record === null) return null;
  const rendered = renderRecord(provider, record);
  if (rendered !== null && rendered.isHumanTurn) return toTranscriptEntry(offset, rendered);
  const compacted = readCompactedFirstUserMessage(record);
  if (compacted === null) return null;
  return toTranscriptEntry(offset, {
    role: "user",
    text: compacted,
    toolCalls: [],
    timestamp: null,
    isHumanTurn: true,
  });
};
