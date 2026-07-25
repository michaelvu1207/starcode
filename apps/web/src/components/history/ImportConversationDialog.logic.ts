/**
 * Everything the import picker decides before it decides how to look.
 *
 * Split out for the usual reason — a component that renders a list is easy to
 * test only when the list is not made inside it — but also because two of the
 * judgements here are the feature's whole point and deserve to be read on
 * their own:
 *
 * **A derived title must look derived.** Roughly 40% of Claude sessions carry
 * a title the CLI wrote for itself; Codex sessions never do. For everything
 * else the server guesses, from the first thing a human typed or, failing
 * that, the directory. The picker exists because titles sometimes lie, so a
 * guess rendered in the same weight as a real title would be the feature
 * arguing against itself.
 *
 * **A refusal is a sentence, not a code.** The server refuses an import for
 * one of thirteen stated preconditions, each with a different fix — the wrong
 * Claude home and a project rooted elsewhere are not the same problem and do
 * not have the same answer. `describeImportRefusal` is where each becomes
 * something a person can act on.
 */
import type { HistoryImportAttempt } from "@t3tools/client-runtime/state/terminal-history";
import type {
  EnvironmentId,
  HistoryImportRecord,
  HistoryTranscriptEntry,
  HistoryImportRefusalReason,
  HistoryProvider,
  HistorySessionId,
  HistorySessionSummary,
  ThreadId,
} from "@t3tools/contracts";

import { historyProviderLabel } from "../sidebar/HistoryProviderIcon";

/** What the picker shows for a session whose file yielded no name at all. */
export const IMPORT_PICKER_UNTITLED_LABEL = "Untitled session";

export interface ImportPickerRowModel {
  readonly sessionId: HistorySessionId;
  readonly provider: HistoryProvider;
  /** Never empty: falls through to `IMPORT_PICKER_UNTITLED_LABEL`. */
  readonly title: string;
  /**
   * True when `title` is this server's guess rather than a name the session
   * carried. Drives the styling, and nothing else.
   */
  readonly titleIsDerived: boolean;
  readonly snippet: string | null;
  readonly projectLabel: string | null;
  readonly projectPath: string | null;
  readonly lastActivityAt: string;
  /** Short relative age, for the row's trailing column. */
  readonly age: string;
  /**
   * The thread a previous import of this session produced, if any. Its
   * presence flips the row's action from "Resume in starcode" to "Open".
   */
  readonly importedThreadId: ThreadId | null;
}

export function buildImportPickerRows(input: {
  readonly sessions: ReadonlyArray<HistorySessionSummary>;
  /**
   * `null` when the machine could not be asked — an older server, or a
   * registry read that failed. Distinct from an empty registry: unknown means
   * no row is badged, which is the safe direction, since a duplicate import
   * returns the original thread anyway.
   */
  readonly imports: ReadonlyArray<HistoryImportRecord> | null;
  readonly nowMs: number;
}): ReadonlyArray<ImportPickerRowModel> {
  const importedBySessionId = new Map<string, ThreadId>();
  for (const record of input.imports ?? []) {
    importedBySessionId.set(record.historySessionId, record.threadId);
  }
  return input.sessions.map((session) => ({
    sessionId: session.id,
    provider: session.provider,
    title: session.title ?? IMPORT_PICKER_UNTITLED_LABEL,
    titleIsDerived: session.title === null || session.titleSource !== "session",
    snippet: session.snippet,
    projectLabel: session.projectLabel,
    projectPath: session.projectPath,
    lastActivityAt: session.lastActivityAt,
    age: formatHistoryAge(session.lastActivityAt, input.nowMs),
    importedThreadId: importedBySessionId.get(session.id) ?? null,
  }));
}

/**
 * Free-text filter over the fields a row actually shows. Deliberately not the
 * preview: searching text the user cannot see in the list would return rows
 * with no visible reason for matching.
 */
export function matchesImportPickerFilter(row: ImportPickerRowModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [row.title, row.snippet, row.projectLabel, row.projectPath].some(
    (value) => value !== null && value.toLowerCase().includes(needle),
  );
}

/** `2h`, `3d`, `Jul 12` — the row has one column for this and no more. */
export function formatHistoryAge(isoDate: string, nowMs: number): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return "";
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return formatShortDate(isoDate);
}

/** `Jul 12`. Used by both the age column and the imported-thread prelude. */
export function formatShortDate(isoDate: string): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return "";
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The refusal reasons, each as the thing that has to change.
 *
 * `detail` is free text the server attached — which home, which cwd, which
 * driver — and it is appended rather than interpolated, so a reason we have
 * not anticipated still arrives intact.
 */
export function describeImportRefusal(
  reason: HistoryImportRefusalReason,
  detail: string | null,
): string {
  const sentence = ((): string => {
    switch (reason) {
      case "session_unreadable":
        return "That session file could not be read. It may have been moved or truncated since the list was built.";
      case "session_id_unusable":
        return "That session carries no id the CLI could resume from.";
      case "session_cwd_unknown":
        return "That session never recorded which directory it ran in, so there is no project to file it under.";
      case "instance_not_found":
        return "This machine has no matching provider configured.";
      case "instance_disabled":
        return "The provider that would run this session is disabled on this machine.";
      case "instance_driver_mismatch":
        return "The chosen provider cannot resume this kind of session.";
      case "instance_home_mismatch":
        return "That session belongs to a different CLI home than the provider configured here, so resuming it would find nothing.";
      case "model_unavailable":
        return "No model is available for the new thread.";
      case "project_not_found":
        return "The project chosen for this import no longer exists.";
      case "project_cwd_mismatch":
        return "That project is rooted somewhere other than the session's directory, which would break the resume.";
      case "project_create_failed":
        return "The project could not be created at the session's directory.";
      case "thread_create_failed":
        return "The thread could not be created.";
      case "binding_write_failed":
        return "The resume link could not be saved, so the thread would have started empty.";
    }
  })();
  const trimmedDetail = detail?.trim() ?? "";
  return trimmedDetail.length === 0 ? sentence : `${sentence} (${trimmedDetail})`;
}

/**
 * The one line an imported thread wears.
 *
 * An imported thread opens with an empty transcript that the model
 * nonetheless remembers every word of. Without this line that is a trap; with
 * it, it is a feature. `messageCount` is null when the server's count hit its
 * byte budget, and an honest omission beats a low number stated as fact.
 */
export function formatImportPreludeLine(input: {
  readonly provider: HistoryProvider;
  readonly messageCount: number | null;
  readonly startedAt: string | null;
}): string {
  const parts = [`Resumed from a ${historyProviderLabel(input.provider)} terminal session`];
  if (input.messageCount !== null) {
    parts.push(
      `${input.messageCount.toLocaleString()} ${input.messageCount === 1 ? "message" : "messages"}`,
    );
  }
  if (input.startedAt !== null) {
    const date = formatShortDate(input.startedAt);
    if (date.length > 0) parts.push(date);
  }
  return parts.join(" · ");
}

/** How much of the opening message survives as a caption above the tail. */
export const IMPORT_PREVIEW_CAPTION_MAX_CHARS = 120;

export interface ImportPreviewTimeline {
  /**
   * The opening message, clipped to a single line, or null when there is no
   * separate opening to caption — a short session whose opening is already in
   * `entries`, or a file that yielded no human turn at all.
   */
  readonly caption: string | null;
  /** Oldest first, newest last: the order a thread is read in. */
  readonly entries: ReadonlyArray<HistoryTranscriptEntry>;
  /** Whether anything was elided between the caption and the first entry. */
  readonly showBreak: boolean;
}

/**
 * Re-weights a preview toward its end.
 *
 * The first cut of this pane led with the opening message and let the tail
 * trail off below the fold, which put the emphasis on the least useful part:
 * every session in a repo opens roughly the same way, and what tells two apart
 * is where they *got to*. So the tail is the content now, rendered like a
 * thread you just scrolled to the end of, and the opening survives only as a
 * caption — enough to recognise a conversation you started, not enough to
 * compete with where it ended up.
 *
 * The caption is dropped entirely when the server sent no separate opening,
 * which is its way of saying the session was short enough that its opening is
 * already in the tail. Captioning it then would print the same message twice.
 */
export function buildImportPreviewTimeline(
  preview: {
    readonly opening: HistoryTranscriptEntry | null;
    readonly tail: ReadonlyArray<HistoryTranscriptEntry>;
    readonly gap: boolean;
  } | null,
): ImportPreviewTimeline {
  if (preview === null) return { caption: null, entries: [], showBreak: false };
  const caption = preview.opening === null ? null : clipToSingleLine(preview.opening.text);
  return {
    caption,
    entries: preview.tail,
    // A break with nothing above it is a line the eye has to explain away.
    showBreak: preview.gap && caption !== null,
  };
}

const clipToSingleLine = (text: string): string | null => {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= IMPORT_PREVIEW_CAPTION_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, IMPORT_PREVIEW_CAPTION_MAX_CHARS).trimEnd()}…`;
};

/**
 * Which machine a request from the seam lands on.
 *
 * The dropdown's footer asks fleet-wide (`null`) because no machine is in
 * context there; a connection group asks for itself. Fleet-wide resolves to
 * the machine you are sitting at, falling back to whatever is paired, because
 * an empty machine selector is a worse first frame than the wrong machine
 * preselected next to a one-click switcher.
 */
export function resolveImportPickerScope(input: {
  readonly requested: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  return input.requested ?? input.primaryEnvironmentId ?? input.environmentIds[0] ?? null;
}

/** What the dialog does next, once an import attempt comes back. */
export type ImportPrompt =
  | { readonly kind: "needsProject"; readonly cwd: string; readonly projectTitle: string }
  | { readonly kind: "error"; readonly message: string };

export type ImportAttemptOutcome =
  | { readonly kind: "openThread"; readonly threadId: ThreadId }
  | { readonly kind: "prompt"; readonly prompt: ImportPrompt };

/**
 * The whole import flow's branching, as a function.
 *
 * Note that `alreadyImported` is not a case: a second import of the same
 * session returns the first one's thread, so the honest response to both is to
 * open it. That is what makes a double-clicked button harmless.
 */
export function resolveImportAttempt(attempt: HistoryImportAttempt): ImportAttemptOutcome {
  switch (attempt.kind) {
    case "imported":
      return { kind: "openThread", threadId: attempt.result.threadId };
    case "needsProject":
      return {
        kind: "prompt",
        prompt: {
          kind: "needsProject",
          cwd: attempt.result.cwd,
          projectTitle: attempt.result.suggestedProjectTitle,
        },
      };
    case "refused":
      return {
        kind: "prompt",
        prompt: {
          kind: "error",
          message: describeImportRefusal(attempt.reason, attempt.detail),
        },
      };
    case "unavailable":
      return { kind: "prompt", prompt: { kind: "error", message: attempt.message } };
  }
}

/** Which CLI session, if any, a thread was imported from. */
export function findHistoryImportForThread(
  imports: ReadonlyArray<HistoryImportRecord> | null,
  threadId: ThreadId | null,
): HistoryImportRecord | null {
  if (imports === null || threadId === null) return null;
  return imports.find((record) => record.threadId === threadId) ?? null;
}
