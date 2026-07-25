// @effect-diagnostics nodeBuiltinImport:off - path and home-directory arithmetic
// over the CLIs' own stores; deliberately pure and injectable rather than
// routed through Effect's Path service.
/**
 * Terminal history - the facts an import has to establish before it writes.
 *
 * Everything here is pure. That is deliberate: these four questions are the
 * whole safety argument for import, and each of them is a function of a file's
 * opening bytes, a path, and a settings blob — nothing that needs a running
 * server to exercise.
 *
 *   1. **What is the session's native id?** The id the CLI itself uses, which
 *      is what gets handed back to it as a resume cursor. For Claude that is
 *      the file's own name; for Codex it is a field in the first record.
 *   2. **Where did it run?** The imported thread's effective working directory
 *      comes from its project, and Claude resolves `--resume` relative to that
 *      directory's project store. A thread filed under the wrong root does not
 *      resume — it fails, or worse, starts empty.
 *   3. **Whose home is it in?** A provider instance is an account: its
 *      `CLAUDE_CONFIG_DIR` / `CODEX_HOME` decides which store the CLI reads.
 *      Resuming a session through an instance that cannot see it is the single
 *      most dangerous failure this feature has, because Codex answers an
 *      unknown thread id with a brand-new empty thread rather than an error.
 *   4. **What should the thread be called?** Cosmetic, and the only question
 *      here allowed a fallback.
 *
 * @module HistoryImportFacts
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HistoryProvider } from "@t3tools/contracts";

import { parseRecord, readRecordProjectPath, renderRecord } from "./records.ts";

/** Title budget. Long enough to be recognisable, short enough for a sidebar row. */
export const IMPORT_TITLE_MAX_CHARS = 80;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `~` expansion against an injectable home directory.
 *
 * `pathExpansion.ts` does this too, but against the process's real home; these
 * roots have to be resolvable against a temp directory in tests, and a fixture
 * that can only be exercised in the developer's actual `~/.claude` is not a
 * test of the ownership check.
 */
const expandTilde = (value: string, homeDir: string): string => {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(homeDir, value.slice(2));
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * Claude's resume id, read from the file name.
 *
 * The name is the id — `claude --resume <uuid>` looks for `<uuid>.jsonl` in
 * the project directory, so the file name is authoritative even though the
 * records inside also carry a `sessionId`. A file whose name is not a uuid is
 * something else (a hand-copied log, a fragment) and is not importable.
 */
export const claudeNativeSessionIdForPath = (absolutePath: string): string | null => {
  const base = NodePath.basename(absolutePath);
  if (!base.endsWith(".jsonl")) return null;
  const stem = base.slice(0, -".jsonl".length);
  return UUID_PATTERN.test(stem) ? stem : null;
};

/** The shape the Claude adapter validates a resume cursor against. */
export const isImportableNativeSessionId = (value: string): boolean => UUID_PATTERN.test(value);

export interface SessionImportFacts {
  /** Codex only: the id from `session_meta`. Claude's comes from the path. */
  readonly nativeSessionId: string | null;
  /** The directory the session ran in, from the session's own records. */
  readonly cwd: string | null;
  /** A summary line the CLI wrote for itself, if it wrote one. */
  readonly summary: string | null;
  /** The first thing a human typed, collapsed to one line. */
  readonly firstUserMessage: string | null;
}

/**
 * Folds a session's opening records into the facts above.
 *
 * Shaped to `SessionHeadConsumer` so it rides the same budgeted head-read the
 * listing's snippet fold uses. It reports complete only once every field it
 * can still learn is filled — for Claude there is no native id to find in the
 * records, so completeness ignores it.
 */
export class SessionImportFold {
  private nativeSessionId: string | null = null;
  private cwd: string | null = null;
  private summary: string | null = null;
  private firstUserMessage: string | null = null;
  private readonly provider: HistoryProvider;

  constructor(provider: HistoryProvider) {
    this.provider = provider;
  }

  push(line: string): boolean {
    const record = parseRecord(line);
    if (record === null) return this.complete;

    if (this.cwd === null) this.cwd = readRecordProjectPath(this.provider, record);

    if (this.nativeSessionId === null && this.provider === "codex") {
      if (record["type"] === "session_meta") {
        const payload = record["payload"];
        if (isRecord(payload)) {
          this.nativeSessionId =
            asNonEmptyString(payload["id"]) ?? asNonEmptyString(payload["session_id"]);
        }
      }
    }

    // Claude writes a `summary` record at the head of a session it has
    // compacted or resumed. When one is there it is a better title than the
    // first message, because it describes the whole session rather than how it
    // opened.
    if (this.summary === null && record["type"] === "summary") {
      this.summary = collapseWhitespace(asNonEmptyString(record["summary"]) ?? "");
      if (this.summary.length === 0) this.summary = null;
    }

    if (this.firstUserMessage === null) {
      const rendered = renderRecord(this.provider, record);
      if (rendered !== null && rendered.isHumanTurn) {
        const collapsed = collapseWhitespace(rendered.text);
        if (collapsed.length > 0) this.firstUserMessage = collapsed;
      }
    }

    return this.complete;
  }

  get complete(): boolean {
    // The summary is never waited for: most sessions have none, and stopping
    // on the first user message is what keeps this to a few KB.
    const idSettled = this.provider === "claude" || this.nativeSessionId !== null;
    return idSettled && this.cwd !== null && this.firstUserMessage !== null;
  }

  get result(): SessionImportFacts {
    return {
      nativeSessionId: this.nativeSessionId,
      cwd: this.cwd,
      summary: this.summary,
      firstUserMessage: this.firstUserMessage,
    };
  }
}

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const clip = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}…`;

/**
 * What to call the imported thread.
 *
 * Set explicitly rather than through a title seed, because a seeded title is
 * the thing the provider is invited to rewrite on the first turn — and an
 * imported thread's name should keep pointing at the session it came from.
 */
export const importThreadTitle = (input: {
  readonly facts: SessionImportFacts;
  readonly provider: HistoryProvider;
  readonly requested?: string | undefined;
}): string => {
  const requested = asNonEmptyString(input.requested ?? null);
  if (requested !== null) return clip(collapseWhitespace(requested), IMPORT_TITLE_MAX_CHARS);
  const summary = asNonEmptyString(input.facts.summary);
  if (summary !== null) return clip(summary, IMPORT_TITLE_MAX_CHARS);
  const firstMessage = asNonEmptyString(input.facts.firstUserMessage);
  if (firstMessage !== null) return clip(firstMessage, IMPORT_TITLE_MAX_CHARS);
  return input.provider === "claude" ? "Imported Claude session" : "Imported Codex session";
};

/** Project title for a project created at a session's cwd. */
export const projectTitleForCwd = (cwd: string): string => {
  const base = NodePath.basename(cwd);
  return base.length > 0 ? base : cwd;
};

/**
 * Where a configured provider instance keeps its sessions.
 *
 * The mapping is the drivers' own, restated: Claude's `homePath` *is* its
 * `CLAUDE_CONFIG_DIR`, so its store is `<homePath>/projects`, and an empty
 * `homePath` means the CLI's default `~/.claude`. Codex's sessions live under
 * the *shared* home even when an instance uses a shadow home for auth — the
 * shadow home symlinks `sessions` back to the shared one — so `homePath` is
 * the only field that matters here.
 *
 * Returns null for any other driver: no other provider has an on-disk session
 * store this feature knows how to resume.
 */
export const instanceSessionStoreRoot = (input: {
  readonly driver: string;
  readonly config: unknown;
  readonly homeDir?: string;
}): { readonly provider: HistoryProvider; readonly root: string } | null => {
  const homeDir = input.homeDir ?? NodeOS.homedir();
  const configuredHome = isRecord(input.config) ? asNonEmptyString(input.config["homePath"]) : null;

  if (input.driver === "claudeAgent") {
    const home =
      configuredHome === null
        ? NodePath.join(homeDir, ".claude")
        : NodePath.resolve(expandTilde(configuredHome, homeDir));
    return { provider: "claude", root: NodePath.join(home, "projects") };
  }
  if (input.driver === "codex") {
    const home =
      configuredHome === null
        ? NodePath.join(homeDir, ".codex")
        : NodePath.resolve(expandTilde(configuredHome, homeDir));
    return { provider: "codex", root: NodePath.join(home, "sessions") };
  }
  return null;
};

/** Built-in instance id that owns a store, when the caller names none. */
export const defaultInstanceIdForHistoryProvider = (provider: HistoryProvider): string =>
  provider === "claude" ? "claudeAgent" : "codex";

/**
 * True when a file sits inside a directory.
 *
 * Segment-wise rather than by prefix, so `~/.claude-homes/work` is not
 * mistaken for a path under `~/.claude`.
 */
export const isPathWithin = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/**
 * The project an imported thread should be filed under.
 *
 * Equality on the resolved path, not containment: a thread whose project root
 * is an *ancestor* of the session's cwd would run the resumed session in the
 * ancestor, and Claude would then look for the session in the wrong project
 * store. Better to offer to create the exact project.
 */
export const findProjectForCwd = <Project extends { readonly workspaceRoot: string }>(
  projects: ReadonlyArray<Project>,
  cwd: string,
): Project | null => {
  const target = NodePath.resolve(cwd);
  return projects.find((project) => NodePath.resolve(project.workspaceRoot) === target) ?? null;
};

/**
 * The resume cursor to persist for a thread bound to a foreign session.
 *
 * The shapes are the adapters' own, and they are not interchangeable: Claude
 * parses four optional fields and only resumes on `resume`
 * (`ClaudeAdapter.readClaudeResumeState`), while Codex's cursor schema is the
 * single `threadId` it passes to `thread/resume`. `turnCount` starts at zero
 * because it counts turns *this* thread has taken, not the session's history.
 */
export const importResumeCursor = (input: {
  readonly provider: HistoryProvider;
  readonly threadId: string;
  readonly nativeSessionId: string;
}): Record<string, unknown> =>
  input.provider === "claude"
    ? { threadId: input.threadId, resume: input.nativeSessionId, turnCount: 0 }
    : { threadId: input.nativeSessionId };
