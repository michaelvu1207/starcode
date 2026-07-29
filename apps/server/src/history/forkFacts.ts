/**
 * Fork-owned: the facts a conversation fork turns on, with no I/O in sight.
 *
 * Two questions, and they are the whole feature:
 *
 * 1. **Can this thread's session be forked at all?** Claude's and Codex's can,
 *    and they earn it differently. The Agent SDK has `forkSession`, which
 *    resumes a transcript and then writes to a *new* session id. Codex's
 *    app-server has `thread/fork`, which does the same job for a rollout — it
 *    reads the source and opens a new thread, rather than appending the way
 *    `thread/resume` would. What both buy is the one property this module
 *    exists to protect: **the source is read and never written.** A driver
 *    without that primitive is refused loudly up front, because the failure it
 *    would otherwise produce — two threads appending to one transcript — is
 *    silent at the time and only surfaces as a model that has forgotten things
 *    it should remember.
 *
 * 2. **What cursor does the fork start life with?** The source's session id,
 *    plus a marker that means "fork it, do not continue it". The marker is the
 *    safety property, not a hint: without it the adapter resumes the source
 *    session in place and both threads append to one file.
 *
 * The marker is self-clearing by construction, which is the part worth
 * understanding before changing anything here. Both adapters rebuild the cursor
 * from scratch rather than spreading the old one —
 * `ClaudeAdapter.updateResumeCursor` writes `{ threadId, resume,
 * resumeSessionAt, turnCount }`, and `CodexSessionRuntime.start` writes
 * `{ threadId: providerThreadId }` from the *opened* thread — so the first
 * durable message replaces this cursor with one pointing at the forked session
 * and carrying no marker. The fork therefore happens exactly once, and a fork
 * whose first turn never reached the provider is still pending rather than
 * silently spent.
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
const FORKABLE_DRIVER_KINDS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export function isForkableDriverKind(driverKind: ProviderDriverKind | string | null): boolean {
  return driverKind !== null && FORKABLE_DRIVER_KINDS.has(driverKind);
}

/**
 * Translates a driver kind into the vocabulary the provenance row speaks.
 *
 * The two-vocabulary hazard the set above warns about, made explicit so callers
 * stop hardcoding `"claude"` on a row that can now describe a Codex fork.
 * Returns null for a driver that cannot fork at all, which callers should have
 * refused before reaching here — so a null is a bug in the caller's ordering
 * rather than a case to render.
 */
export function historyProviderForDriverKind(
  driverKind: ProviderDriverKind | string | null,
): "claude" | "codex" | null {
  if (driverKind === "codex") return "codex";
  if (driverKind === "claudeAgent") return "claude";
  return null;
}

/** A v4 UUID, which is what Claude names its session files after. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider session id a thread's persisted cursor points at, or null.
 *
 * Driver-aware because the two cursors agree on nothing. Claude's names the
 * session under `resume` (or the older `sessionId`) and it is a UUID, because
 * that is what the SDK names its transcript files after. Codex's names the
 * app-server thread under `threadId`, and its shape is the app server's
 * business rather than ours — so it is checked for being a non-empty string and
 * nothing more. Validating a Codex id against `UUID_PATTERN` would refuse every
 * real Codex thread, and would read exactly like a feature that was never
 * wired up.
 */
export function readForkableSessionId(
  resumeCursor: unknown,
  driverKind: ProviderDriverKind | string | null,
): string | null {
  if (resumeCursor === null || typeof resumeCursor !== "object") return null;

  if (driverKind === "codex") {
    const cursor = resumeCursor as { readonly threadId?: unknown };
    return typeof cursor.threadId === "string" && cursor.threadId.length > 0
      ? cursor.threadId
      : null;
  }

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
 * Two shapes, because the two adapters read two different cursors and neither
 * would recognise the other's. What they share is the `fork: true` marker,
 * which each adapter turns into its own verb — `forkSession` for the SDK,
 * `thread/fork` for the app server.
 *
 * `turnCount: 0` on the Claude side because the fork has said nothing yet — the
 * count is this thread's, not the transcript's, and seeding it from the source
 * would make the fork's first turn look like a continuation in every log that
 * reads it.
 *
 * No `resumeSessionAt`. That field truncates a resume at a given assistant
 * message, and a fork with no argument means "everything the source has said";
 * carrying the source's value would silently rewind the fork to wherever the
 * source last happened to be. Codex's `lastTurnId` is the same idea and is
 * omitted for the same reason.
 *
 * `ephemeral` is Codex-only and reaches `thread/fork` as the flag that stops
 * the app server persisting a rollout for the fork. It is deliberately not
 * faked for Claude: the SDK has no equivalent, and a cursor that carried a
 * field its adapter ignores would read as a promise this code cannot keep.
 * A side thread on Claude is ephemeral in *our* store and durable in the SDK's,
 * which is the honest description of what happens.
 */
export function forkResumeCursor(input: {
  readonly threadId: ThreadId;
  readonly sourceSessionId: string;
  readonly driverKind: ProviderDriverKind | string | null;
  readonly ephemeral?: boolean;
}): Record<string, unknown> {
  if (input.driverKind === "codex") {
    return {
      threadId: input.sourceSessionId,
      fork: true,
      ...(input.ephemeral === true ? { ephemeral: true } : {}),
    };
  }

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
