/**
 * Parses the envelope agent-to-agent messages arrive in.
 *
 * These reach the transcript as ordinary user messages, because that is exactly
 * what they are: an immediately-delivered message is the text of the turn it
 * starts. Without this they render through `ChatMarkdown`, whose sanitizer
 * unwraps elements it does not know — so `<message from-thread="…"
 * from-machine="…">` reaches the operator as its children alone, every
 * attribute dropped. The server compensates by restating the sender in prose,
 * which is legible but still leaves the message looking like something the
 * operator typed.
 *
 * Parsing it here is what makes the distinction visible rather than merely
 * present: another agent's words are the one kind of user message nobody in
 * this fleet wrote, and the operator reading a transcript should not have to
 * infer that from a sentence in the body.
 *
 * Mirrors `reviewCommentContext.ts`, which solves the same problem for review
 * comments, down to the segment shape — a message can carry an envelope *and*
 * ordinary text, and both have to render.
 *
 * @module MailboxMessageContext
 */

const MAILBOX_BLOCK_PATTERN =
  /<mailbox-messages count="(\d+)">\n([\s\S]*?)\n<\/mailbox-messages>/gu;
const MAILBOX_ENTRY_PATTERN = /<message ([^>]*)>\n([\s\S]*?)\n<\/message>/gu;
const ATTRIBUTE_PATTERN = /([a-z-]+)="([^"]*)"/gu;

export interface MailboxMessageEntry {
  readonly id: string;
  /** Sender thread's title, or its id when it had no title. Null when unknown. */
  readonly fromThread: string | null;
  readonly fromMachine: string | null;
  readonly sentAt: string | null;
  readonly body: string;
}

export type MailboxMessageSegment =
  | { readonly kind: "text"; readonly id: string; readonly text: string }
  | { readonly kind: "mailbox"; readonly id: string; readonly entry: MailboxMessageEntry };

const attributesOf = (raw: string): ReadonlyMap<string, string> => {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    if (match[1] !== undefined && match[2] !== undefined) attributes.set(match[1], match[2]);
  }
  return attributes;
};

/**
 * Strips the prose provenance line the server writes for readers that never get
 * here — the mobile app, and any client without this parser. Rendering it inside
 * a card that already states the sender would say the same thing twice, so it is
 * removed on recognition rather than never written: the line is load-bearing
 * wherever this parser is absent.
 */
const PROSE_PROVENANCE_PATTERN = /^From .+ at \d{4}-\d{2}-\d{2}T[^\n]*:\n/u;

const parseEntries = (block: string): ReadonlyArray<MailboxMessageEntry> => {
  const entries: Array<MailboxMessageEntry> = [];
  for (const match of block.matchAll(MAILBOX_ENTRY_PATTERN)) {
    const attributes = attributesOf(match[1] ?? "");
    const body = (match[2] ?? "").replace(PROSE_PROVENANCE_PATTERN, "");
    entries.push({
      id: `mailbox-entry:${entries.length}`,
      fromThread: attributes.get("from-thread") ?? attributes.get("from-thread-id") ?? null,
      fromMachine: attributes.get("from-machine") ?? null,
      sentAt: attributes.get("sent-at") ?? null,
      body,
    });
  }
  return entries;
};

/**
 * Splits a message into envelope entries and whatever surrounds them.
 *
 * A block that parses to no entries is deliberately left as text: it is either
 * an envelope shape this client does not understand or a message that merely
 * mentions one, and showing the raw thing beats showing an empty card.
 */
export const parseMailboxMessageSegments = (
  value: string,
): ReadonlyArray<MailboxMessageSegment> => {
  const segments: Array<MailboxMessageSegment> = [];
  let cursor = 0;

  for (const match of value.matchAll(MAILBOX_BLOCK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const before = value.slice(cursor, matchIndex);
    if (before.length > 0) {
      segments.push({ kind: "text", id: `mailbox-text:${cursor}`, text: before });
    }

    const entries = parseEntries(match[2] ?? "");
    if (entries.length === 0) {
      segments.push({ kind: "text", id: `mailbox-invalid:${matchIndex}`, text: match[0] });
    } else {
      for (const entry of entries) {
        segments.push({
          kind: "mailbox",
          id: `mailbox:${matchIndex}:${entry.id}`,
          entry,
        });
      }
    }
    cursor = matchIndex + match[0].length;
  }

  const rest = value.slice(cursor);
  if (rest.length > 0) {
    segments.push({ kind: "text", id: `mailbox-text:${cursor}`, text: rest });
  }
  return segments;
};

export const containsMailboxMessage = (value: string): boolean =>
  parseMailboxMessageSegments(value).some((segment) => segment.kind === "mailbox");
