// @effect-diagnostics nodeBuiltinImport:off globalDate:off - discovery reads Codex's own
// append-only session store, just like the history subsystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HistorySessionId } from "@starcode/contracts";
import { HostProcessPlatform } from "@starcode/shared/hostProcess";
import * as Effect from "effect/Effect";

import { codexNativeSessionIdForPath } from "../../history/importFacts.ts";
import { historySessionIdForPath } from "../../history/paths.ts";
import { parseRecord } from "../../history/records.ts";

export interface CodexCliRolloutLink {
  readonly historySessionId: HistorySessionId;
  readonly nativeSessionId: string;
  readonly path: string;
}

export type CodexCliRolloutTerminalState = "completed" | "failed" | null;

export interface CodexCliRolloutTerminal {
  readonly status: Exclude<CodexCliRolloutTerminalState, null>;
  readonly at: string;
}

export const CODEX_CLI_DISCOVERY_WINDOW_MS = 20_000;
export const CODEX_CLI_DISCOVERY_MAX_CANDIDATES = 128;
const LAUNCH_HEAD_MAX_BYTES = 2 * 1024 * 1024;
const TERMINAL_TAIL_BYTES = 512 * 1024;
const ROLLOUT_LIVENESS_TIMEOUT_MS = 1_000;

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

function candidateDateDirectories(root: string, startedAt: Date): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const deltaDays of [-1, 0, 1]) {
    const value = new Date(startedAt.getTime() + deltaDays * 86_400_000);
    for (const utc of [false, true]) {
      const year = utc ? value.getUTCFullYear() : value.getFullYear();
      const month = (utc ? value.getUTCMonth() : value.getMonth()) + 1;
      const day = utc ? value.getUTCDate() : value.getDate();
      directories.add(
        NodePath.join(
          root,
          String(year),
          String(month).padStart(2, "0"),
          String(day).padStart(2, "0"),
        ),
      );
    }
  }
  return [...directories];
}

interface CodexCliLaunchFacts {
  readonly meta: Record<string, unknown>;
  readonly openingPrompt: string;
}

/**
 * Reads the complete first user prompt rather than the clipped display entry
 * used by the history UI. If either the preamble or prompt crosses the hard
 * budget, correlation is unavailable instead of falling back to prefix
 * equality.
 */
async function readCodexCliLaunchFacts(path: string): Promise<CodexCliLaunchFacts | null> {
  const handle = await NodeFSP.open(path, "r");
  try {
    const stats = await handle.stat();
    const readSize = Math.min(stats.size, LAUNCH_HEAD_MAX_BYTES);
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const region = buffer.subarray(0, bytesRead);
    const reachedEof = bytesRead >= stats.size;
    const lines = region.toString("utf8").split("\n");
    if (!reachedEof) lines.pop();

    const meta = parseRecord(lines[0] ?? "");
    if (meta === null) return null;
    for (let index = 1; index < lines.length; index += 1) {
      const record = parseRecord(lines[index] ?? "");
      if (record?.type !== "event_msg") continue;
      const payload =
        record.payload !== null &&
        typeof record.payload === "object" &&
        !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : null;
      if (payload?.type !== "user_message" || typeof payload.message !== "string") continue;
      return { meta, openingPrompt: payload.message };
    }
    return null;
  } finally {
    await handle.close();
  }
}

function isCodexExecSessionMeta(
  record: Record<string, unknown>,
  expectedCwd: string,
  startedAtMs: number,
): boolean {
  if (record.type !== "session_meta") return false;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : null;
  if (!payload) return false;
  const source = payload.source;
  const originator =
    typeof payload.originator === "string" ? payload.originator.trim().toLowerCase() : "";
  const threadSource =
    typeof payload.thread_source === "string" ? payload.thread_source.trim().toLowerCase() : null;
  if (source !== "exec" || originator !== "codex_exec") return false;
  if (threadSource !== null && threadSource !== "user") return false;
  if (
    typeof payload.cwd !== "string" ||
    NodePath.resolve(payload.cwd) !== NodePath.resolve(expectedCwd)
  ) {
    return false;
  }
  const timestamp =
    typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return (
    Number.isFinite(timestamp) && Math.abs(timestamp - startedAtMs) <= CODEX_CLI_DISCOVERY_WINDOW_MS
  );
}

function promptMatches(opening: string, prompt: string): boolean {
  const normalizedOpening = normalizeText(opening);
  const normalizedPrompt = normalizeText(prompt);
  return normalizedOpening.length > 0 && normalizedOpening === normalizedPrompt;
}

/**
 * Find the one rollout that an observed `codex exec` launch can be proved to
 * own. Ambiguity is a null result, never a best guess.
 */
export async function discoverCodexCliRollout(input: {
  readonly codexHome?: string | undefined;
  readonly cwd: string;
  readonly prompt: string;
  readonly startedAt: string;
}): Promise<CodexCliRolloutLink | null> {
  const startedAtMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  const root = NodePath.join(
    input.codexHome ?? NodePath.join(NodeOS.homedir(), ".codex"),
    "sessions",
  );
  const matches: CodexCliRolloutLink[] = [];
  const candidates: Array<{ readonly path: string; readonly nativeSessionId: string }> = [];
  let candidateNamesSeen = 0;

  for (const directory of candidateDateDirectories(root, new Date(startedAtMs))) {
    let names: string[];
    try {
      names = await NodeFSP.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = NodePath.join(directory, name);
      const nativeSessionId = codexNativeSessionIdForPath(path);
      if (!nativeSessionId) continue;
      candidateNamesSeen += 1;
      if (candidateNamesSeen > CODEX_CLI_DISCOVERY_MAX_CANDIDATES) return null;
      try {
        const stats = await NodeFSP.stat(path);
        if (!stats.isFile() || stats.mtimeMs < startedAtMs - CODEX_CLI_DISCOVERY_WINDOW_MS) {
          continue;
        }
        candidates.push({ path, nativeSessionId });
      } catch {
        // The file can disappear between readdir and stat. The caller polls.
      }
    }
  }

  for (const { path, nativeSessionId } of candidates) {
    try {
      const facts = await readCodexCliLaunchFacts(path);
      if (!facts || !isCodexExecSessionMeta(facts.meta, input.cwd, startedAtMs)) continue;
      if (!promptMatches(facts.openingPrompt, input.prompt)) continue;
      matches.push({
        historySessionId: historySessionIdForPath(path),
        nativeSessionId,
        path,
      });
    } catch {
      // A rollout can be created between readdir and its first complete line.
      // The caller polls, so a partial candidate is simply not ready yet.
    }
  }

  return matches.length === 1 ? matches[0]! : null;
}

/** Reads only the tail needed to prove a Codex exec terminal record. */
export async function readCodexCliRolloutTerminal(
  path: string,
  after?: string,
): Promise<CodexCliRolloutTerminal | null> {
  const afterMs = after ? Date.parse(after) : Number.NEGATIVE_INFINITY;
  const handle = await NodeFSP.open(path, "r");
  try {
    const stats = await handle.stat();
    const start = Math.max(0, stats.size - TERMINAL_TAIL_BYTES);
    const buffer = Buffer.alloc(stats.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").toReversed();
    for (const line of lines) {
      const record = parseRecord(line);
      if (!record || record.type !== "event_msg") continue;
      const payload =
        record.payload && typeof record.payload === "object"
          ? (record.payload as Record<string, unknown>)
          : null;
      const timestamp =
        typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      if (!Number.isFinite(timestamp) || timestamp < afterMs) continue;
      if (payload?.type === "task_complete") {
        return { status: "completed", at: record.timestamp as string };
      }
      if (payload?.type === "turn_aborted" || payload?.type === "task_failed") {
        return { status: "failed", at: record.timestamp as string };
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function readCodexCliRolloutTerminalState(
  path: string,
  after?: string,
): Promise<CodexCliRolloutTerminalState> {
  return (await readCodexCliRolloutTerminal(path, after))?.status ?? null;
}

/**
 * Codex retains its rollout JSONL writer for the lifetime of an active exec
 * session. An exact open-file check therefore distinguishes a live writer from
 * an orphaned non-terminal file without guessing from file age or prompt text.
 *
 * `null` means the host cannot perform the probe; callers must preserve their
 * conservative fallback instead of declaring the rollout stopped.
 */
export async function probeCodexCliRolloutLiveness(path: string): Promise<boolean | null> {
  const platform = await Effect.runPromise(HostProcessPlatform);
  if (platform === "win32") return null;
  const command = platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  return await new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      ["-t", "--", path],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: ROLLOUT_LIVENESS_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout.trim().length > 0);
          return;
        }
        const exitCode =
          typeof error === "object" && error !== null && "code" in error ? error.code : null;
        // lsof uses exit 1 with no diagnostic when no process has the file
        // open. Missing binaries, permissions, and timeouts are unknown.
        resolve(exitCode === 1 && stderr.trim().length === 0 ? false : null);
      },
    );
  });
}
