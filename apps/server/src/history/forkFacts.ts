/**
 * Fork-owned: the facts a conversation fork turns on, with no I/O in sight.
 *
 * Two questions, and they are the whole feature:
 *
 * 1. **Can this thread's session be forked at all?** Only Claude's can. The
 *    Agent SDK has `forkSession`, which resumes a transcript and then writes to
 *    a *new* session id. Codex's app-server has no fork verb — `thread/start`
 *    and `thread/resume` are the only two, and resuming appends to the same
 *    rollout file — so a Codex "fork" would be two threads writing one
 *    transcript, which is the exact corruption this feature exists to avoid.
 *    Worse, it would be silent: Codex answers an unknown thread id with a fresh
 *    empty thread rather than an error. So Codex is refused, loudly, up front.
 *
 * 2. **What cursor does the fork start life with?** The source's session id,
 *    plus a marker that means "fork it, do not continue it". The marker is the
 *    safety property, not a hint: without it the adapter resumes the source
 *    session in place and both threads append to one file.
 *
 * The marker is self-clearing by construction, which is the part worth
 * understanding before changing anything here. `ClaudeAdapter.updateResumeCursor`
 * rebuilds the cursor from scratch — `{ threadId, resume, resumeSessionAt,
 * turnCount }`, never spreading the old one — so the first durable message from
 * the SDK replaces this cursor with one pointing at the *forked* session and no
 * marker. The fork therefore happens exactly once, and a fork whose first turn
 * never reached the provider is still pending rather than silently spent.
 *
 * @module HistoryForkFacts
 */
import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";

/**
 * The drivers whose sessions can be forked without touching the original.
 *
 * A list rather than an equality check because the next one to gain a fork
 * primitive (OpenCode already has `session.fork`, and the adapter already calls
 * it as a cwd-mismatch rescue) belongs here and nowhere else.
 *
 * ⚠️ These are `ProviderDriverKind`s, which are **not** the vocabulary the rest
 * of this module speaks. Claude's driver kind is `claudeAgent`
 * (`Drivers/ClaudeDriver.ts`), while `HistoryProvider` — the enum on the
 * listing, the import record and this endpoint's result — spells the same
 * provider `claude`. Getting this wrong does not fail loudly: every real Claude
 * thread would simply be refused as unforkable, which reads exactly like a
 * feature that was never wired up.
 */
const FORKABLE_DRIVER_KINDS: ReadonlySet<string> = new Set(["claudeAgent"]);

export function isForkableDriverKind(driverKind: ProviderDriverKind | string | null): boolean {
  return driverKind !== null && FORKABLE_DRIVER_KINDS.has(driverKind);
}

/** A v4 UUID, which is what Claude names its session files after. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider session id a thread's persisted cursor points at, or null.
 *
 * Reads both spellings the adapter accepts (`resume` and the older
 * `sessionId`) and validates the shape, because an id that is not a UUID is not
 * a session file and asking the SDK to resume it fails at the far end of a
 * process spawn rather than here.
 */
export function readForkableSessionId(resumeCursor: unknown): string | null {
  if (resumeCursor === null || typeof resumeCursor !== "object") return null;
  const cursor = resumeCursor as { readonly resume?: unknown; readonly sessionId?: unknown };
  const candidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : null;
  return candidate !== null && UUID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The cursor a forked thread is born with.
 *
 * `turnCount: 0` because the fork has said nothing yet — the count is this
 * thread's, not the transcript's, and seeding it from the source would make the
 * fork's first turn look like a continuation in every log that reads it.
 *
 * No `resumeSessionAt`. That field truncates a resume at a given assistant
 * message, and a fork with no argument means "everything the source has said";
 * carrying the source's value would silently rewind the fork to wherever the
 * source last happened to be.
 */
export function forkResumeCursor(input: {
  readonly threadId: ThreadId;
  readonly sourceSessionId: string;
}): Record<string, unknown> {
  return {
    threadId: input.threadId,
    resume: input.sourceSessionId,
    fork: true,
    turnCount: 0,
  };
}

/**
 * The cwd a fork inherits, read back out of the source binding's runtime
 * payload.
 *
 * It matters that this is the *binding's* cwd rather than the project's: a
 * thread on a worktree runs somewhere its project does not, and Claude's
 * session store is keyed by working directory, so a fork that resumed from the
 * wrong cwd would look in the wrong project directory and find nothing.
 */
export function readBindingCwd(runtimePayload: unknown): string | null {
  if (runtimePayload === null || typeof runtimePayload !== "object") return null;
  const payload = runtimePayload as { readonly cwd?: unknown };
  return typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : null;
}

/** How long a fork's title may run before it stops being a row you can read. */
const FORK_TITLE_MAX_LENGTH = 120;
const FORK_TITLE_SUFFIX = " (fork)";

/**
 * Names the fork after its source.
 *
 * Deliberately the same rule the client uses for the setup-only fork, so the
 * two paths cannot disagree about what a fork is called; the client sends no
 * title in the common case and this is what it gets.
 */
export function forkThreadTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim();
  const room = FORK_TITLE_MAX_LENGTH - FORK_TITLE_SUFFIX.length;
  const base = trimmed.length > room ? `${trimmed.slice(0, room - 1)}…` : trimmed;
  return `${base}${FORK_TITLE_SUFFIX}`;
}
