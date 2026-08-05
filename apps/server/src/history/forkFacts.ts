/**
 * Fork-owned: the facts a conversation fork turns on, with no I/O in sight.
 *
 * Two questions, and they are the whole feature:
 *
 * 1. **Can this thread's session be forked at all?** Only Pi can. Its
 *    `SessionManager.forkFrom` copies the source branch into a new transcript,
 *    preserving the one property this module exists to protect: **the source
 *    is read and never written.** Legacy Claude Agent SDK and Codex app-server
 *    bindings remain readable provenance, but their runtimes have been
 *    removed, so they are refused rather than replayed through Pi.
 *
 * 2. **What cursor does the fork start life with?** Pi's source session file
 *    and id, plus a marker that means "fork it, do not continue it". The marker
 *    is the safety property, not a hint: without it the adapter opens the
 *    source transcript in place and both threads append to one file.
 *
 * Pi rebuilds its durable cursor from the newly created session, so a
 * successful start clears the marker. A failed start leaves the marker intact
 * and can never silently degrade into a blank session.
 *
 * @module HistoryForkFacts
 */
import type { HistoryForkProvider, ProviderDriverKind } from "@starcode/contracts";

/**
 * The drivers whose sessions can be forked without touching the original.
 *
 * A set keeps eligibility explicit. In particular, the retired `codex` and
 * `claudeAgent` names must never become aliases for Pi: their cursor formats
 * address different transcript stores.
 */
const FORKABLE_DRIVER_KINDS: ReadonlySet<string> = new Set(["pi"]);

export function isForkableDriverKind(driverKind: ProviderDriverKind | string | null): boolean {
  return driverKind !== null && FORKABLE_DRIVER_KINDS.has(driverKind);
}

/**
 * Translates a driver kind into the vocabulary the provenance row speaks.
 *
 * Returns null for every retired or unsupported driver so provenance can never
 * claim Pi resumed a Claude/Codex-native session.
 */
export function historyProviderForDriverKind(
  driverKind: ProviderDriverKind | string | null,
): HistoryForkProvider | null {
  return driverKind === "pi" ? "pi" : null;
}

export interface ForkableSessionCursor {
  readonly sessionFile: string;
  readonly sessionId: string;
}

/**
 * Both coordinates Pi needs to copy a transcript, or null. Requiring the file
 * and id prevents a partial/legacy cursor from being reinterpreted as Pi.
 */
export function readForkableSessionCursor(
  resumeCursor: unknown,
  driverKind: ProviderDriverKind | string | null,
): ForkableSessionCursor | null {
  if (driverKind !== "pi" || resumeCursor === null || typeof resumeCursor !== "object") {
    return null;
  }
  const cursor = resumeCursor as {
    readonly sessionFile?: unknown;
    readonly sessionId?: unknown;
  };
  if (
    typeof cursor.sessionFile !== "string" ||
    cursor.sessionFile.trim().length === 0 ||
    typeof cursor.sessionId !== "string" ||
    cursor.sessionId.trim().length === 0
  ) {
    return null;
  }
  return {
    sessionFile: cursor.sessionFile,
    sessionId: cursor.sessionId,
  };
}

/**
 * The cursor a forked thread is born with.
 *
 * The file is the actual source of truth; the id is retained for durable
 * identity and provenance. `fork: true` instructs Pi to call `forkFrom`
 * instead of opening the file in place. Unsupported drivers receive no cursor.
 */
export function forkResumeCursor(input: {
  readonly sourceSessionFile: string;
  readonly sourceSessionId: string;
  readonly driverKind: ProviderDriverKind | string | null;
}): Record<string, unknown> {
  if (input.driverKind === "pi") {
    return {
      sessionFile: input.sourceSessionFile,
      sessionId: input.sourceSessionId,
      fork: true,
    };
  }
  return {};
}

/**
 * The cwd a fork inherits, read back out of the source binding's runtime
 * payload.
 *
 * It matters that this is the *binding's* cwd rather than the project's: a
 * thread on a worktree runs somewhere its project does not, and Claude's
 * new Pi transcript should retain that exact execution directory.
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
