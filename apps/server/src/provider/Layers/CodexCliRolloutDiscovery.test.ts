// @effect-diagnostics nodeBuiltinImport:off globalDate:off - writes isolated rollout fixtures
// with fixed wall-clock timestamps.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_CLI_DISCOVERY_MAX_CANDIDATES,
  discoverCodexCliRollout,
  readCodexCliRolloutTerminal,
  readCodexCliRolloutTerminalState,
  resolveCodexCliInvocationPrompt,
} from "./CodexCliRolloutDiscovery.ts";

const SESSION_ID = "019fb522-53f8-70c2-918c-b0010a25f36e";
const STARTED_AT = "2026-07-30T22:25:54.039Z";
const PROMPT = "Consolidate the road-network representation and report the exact invariants.";

async function writeRollout(input: {
  readonly home: string;
  readonly id?: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly source?: unknown;
  readonly originator?: unknown;
  readonly threadSource?: unknown;
  readonly terminal?: "task_complete" | "turn_aborted";
}) {
  const id = input.id ?? SESSION_ID;
  const directory = NodePath.join(input.home, ".codex", "sessions", "2026", "07", "30");
  await NodeFSP.mkdir(directory, { recursive: true });
  const path = NodePath.join(directory, `rollout-2026-07-30T22-25-54-${id}.jsonl`);
  const records = [
    {
      timestamp: STARTED_AT,
      type: "session_meta",
      payload: {
        id,
        cwd: input.cwd ?? "/work/router",
        originator: input.originator ?? "codex_exec",
        source: input.source ?? "exec",
        thread_source: input.threadSource ?? "user",
      },
    },
    {
      timestamp: "2026-07-30T22:25:55.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: input.prompt ?? PROMPT },
    },
    ...(input.terminal
      ? [
          {
            timestamp: "2026-07-30T22:26:10.000Z",
            type: "event_msg",
            payload: { type: input.terminal },
          },
        ]
      : []),
  ];
  await NodeFSP.writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

describe("CodexCliRolloutDiscovery", () => {
  it("reads a proved prompt file relative to the launch shell cwd", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-prompt-"));
    const worktree = NodePath.join(home, "worktree");
    const promptPath = NodePath.join(worktree, "specs", "ui-inventory.md");
    await NodeFSP.mkdir(NodePath.dirname(promptPath), { recursive: true });
    await NodeFSP.writeFile(promptPath, PROMPT);

    expect(
      await resolveCodexCliInvocationPrompt({
        parentCwd: home,
        invocation: {
          description: "Codex CLI subagent",
          shellCwd: "worktree",
          promptFile: "specs/ui-inventory.md",
          detached: true,
        },
      }),
    ).toBe(PROMPT);
  });

  it("links one exact codex_exec rollout by origin, cwd, time, and prompt", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
    const path = await writeRollout({ home, terminal: "task_complete" });
    const link = await discoverCodexCliRollout({
      codexHome: NodePath.join(home, ".codex"),
      cwd: "/work/router",
      prompt: PROMPT,
      startedAt: STARTED_AT,
    });
    expect(link?.nativeSessionId).toBe(SESSION_ID);
    expect(link?.path).toBe(path);
    expect(link?.historySessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(await readCodexCliRolloutTerminal(path)).toEqual({
      status: "completed",
      at: "2026-07-30T22:26:10.000Z",
    });
    expect(await readCodexCliRolloutTerminalState(path)).toBe("completed");
    expect(await readCodexCliRolloutTerminalState(path, "2026-07-30T22:27:00.000Z")).toBeNull();
  });

  it("leaves concurrent same-cwd candidates ambiguous instead of attaching the wrong transcript", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
    await writeRollout({ home });
    await writeRollout({
      home,
      id: "019fb522-6768-7772-acc9-798520fbee2a",
    });
    expect(
      await discoverCodexCliRollout({
        codexHome: NodePath.join(home, ".codex"),
        cwd: "/work/router",
        prompt: PROMPT,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("rejects non-exec sessions and prompt mismatches", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
    await writeRollout({
      home,
      source: { subagent: {} },
      prompt: "Another worker prompt entirely.",
    });
    expect(
      await discoverCodexCliRollout({
        codexHome: NodePath.join(home, ".codex"),
        cwd: "/work/router",
        prompt: PROMPT,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("requires the exact top-level exec origin and rejects nested subagents", async () => {
    const cases = [
      { source: "exec", originator: "Codex Desktop" },
      {
        source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } },
        originator: "codex_exec",
        threadSource: "subagent",
      },
      { source: "exec", originator: "codex_exec", threadSource: "subagent" },
    ] as const;

    for (const [index, candidate] of cases.entries()) {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
      await writeRollout({
        home,
        id: `019fb522-6768-7772-acc9-${String(index).padStart(12, "0")}`,
        ...candidate,
      });
      expect(
        await discoverCodexCliRollout({
          codexHome: NodePath.join(home, ".codex"),
          cwd: "/work/router",
          prompt: PROMPT,
          startedAt: STARTED_AT,
        }),
      ).toBeNull();
    }
  });

  it("compares the complete normalized prompt instead of a clipped prefix", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
    const sharedPrefix = "same ".repeat(1_000);
    await writeRollout({ home, prompt: `${sharedPrefix}rollout suffix` });

    expect(
      await discoverCodexCliRollout({
        codexHome: NodePath.join(home, ".codex"),
        cwd: "/work/router",
        prompt: `${sharedPrefix}different requested suffix`,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("matches a complete long multiline prompt after whitespace normalization", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
    const prompt = `${"Long instruction ".repeat(400)}\n\nFinish with the report.`;
    await writeRollout({ home, prompt });

    const link = await discoverCodexCliRollout({
      codexHome: NodePath.join(home, ".codex"),
      cwd: "/work/router",
      prompt: prompt.replace("\n\n", "   "),
      startedAt: STARTED_AT,
    });
    expect(link?.nativeSessionId).toBe(SESSION_ID);
  });

  it("prefilters rollout mtime before reading launch evidence", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
    const stalePath = await writeRollout({ home });
    const staleSeconds = Date.parse("2026-07-30T22:00:00.000Z") / 1_000;
    await NodeFSP.utimes(stalePath, staleSeconds, staleSeconds);

    expect(
      await discoverCodexCliRollout({
        codexHome: NodePath.join(home, ".codex"),
        cwd: "/work/router",
        prompt: PROMPT,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("returns unavailable when the launch-time candidate budget is exceeded", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-link-"));
    for (let index = 0; index <= CODEX_CLI_DISCOVERY_MAX_CANDIDATES; index += 1) {
      await writeRollout({
        home,
        id: `019fb522-6768-7772-acc9-${index.toString(16).padStart(12, "0")}`,
      });
    }

    expect(
      await discoverCodexCliRollout({
        codexHome: NodePath.join(home, ".codex"),
        cwd: "/work/router",
        prompt: PROMPT,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });
});
