/**
 * One message out of a CLI session, wearing the same clothes the real
 * transcript gives it.
 *
 * Extracted from the import picker rather than written twice. Two surfaces
 * render these now — the picker's preview and an imported thread's earlier
 * conversation — and they are the same thing seen at two depths, so a second
 * renderer would drift into a second visual vocabulary for messages the reader
 * already knows how to read.
 *
 * There are no role labels: a right-aligned bubble is the user and full-bleed
 * prose is the assistant, everywhere else in the app. Assistant text goes
 * through `ChatMarkdown` for the same reason — the CLIs write markdown, and a
 * rendering that showed literal asterisks would look broken rather than lossy.
 */
import type { HistoryTranscriptEntry } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";

export function HistoryMessage(props: {
  readonly entry: HistoryTranscriptEntry;
  readonly cwd: string | null;
  /**
   * Dims the message to say it is not part of this thread's conversation.
   *
   * The picker's preview does not set it — there, the messages *are* the
   * content. An imported thread's history does, because the live turns below
   * it are the content and history that competed with them for attention would
   * read as though the thread had already said all this.
   */
  readonly muted?: boolean;
}): ReactNode {
  const { entry } = props;
  const text = entry.truncated ? `${entry.text}…` : entry.text;
  if (entry.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div
          className={cn(
            "max-w-[85%] min-w-0 break-words rounded-2xl bg-accent px-3 py-2 text-xs",
            props.muted === true && "bg-accent/50",
          )}
        >
          {/* `lineBreaks` for the same reason the real timeline sets it: a
              human typing into a composer means their newlines. */}
          <ChatMarkdown
            text={text}
            cwd={props.cwd ?? undefined}
            className={props.muted === true ? "text-muted-foreground" : "text-foreground"}
            lineBreaks
          />
        </div>
      </div>
    );
  }
  return (
    <div className={cn("min-w-0 text-xs", props.muted === true && "text-muted-foreground")}>
      {text.trim().length > 0 ? <ChatMarkdown text={text} cwd={props.cwd ?? undefined} /> : null}
      {/* Names only, never payloads — the server's renderer is lossy by design
          and this is the one trace that work happened between two messages. */}
      {entry.toolCalls.length > 0 ? (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/50">
          {entry.toolCalls.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
