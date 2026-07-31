// @effect-diagnostics nodeBuiltinImport:off - writes isolated rollout fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EventId, type OrchestrationThreadActivity } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { enrichHistoricalCodexCliActivities } from "./CodexCliHistoricalProjection.ts";

const SESSION_ID = "019fb522-53f8-70c2-918c-b0010a25f36e";
const STARTED_AT = "2026-07-30T22:25:52.878Z";
const PROMPT = "Carry out the assignment and write RESULT.md.";

function activity(
  command: string,
  options: {
    readonly legacyItemId?: boolean;
    readonly kind?: "tool.updated" | "tool.completed";
  } = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make("launch"),
    tone: "tool",
    kind: options.kind ?? "tool.updated",
    summary: "Launch worker",
    payload: {
      ...(options.legacyItemId ? { itemId: "toolu_launch" } : { providerItemId: "toolu_launch" }),
      data: { toolName: "Bash", input: { command } },
    },
    turnId: null,
    createdAt: STARTED_AT,
  };
}

async function writeRollout(home: string) {
  const directory = NodePath.join(home, ".codex", "sessions", "2026", "07", "30");
  await NodeFSP.mkdir(directory, { recursive: true });
  const path = NodePath.join(directory, `rollout-2026-07-30T15-25-54-${SESSION_ID}.jsonl`);
  await NodeFSP.writeFile(
    path,
    [
      {
        timestamp: "2026-07-30T22:25:54.039Z",
        type: "session_meta",
        payload: {
          id: SESSION_ID,
          cwd: "/work/phase2-router",
          originator: "codex_exec",
          source: "exec",
        },
      },
      {
        timestamp: "2026-07-30T22:25:55.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: PROMPT },
      },
      {
        timestamp: "2026-07-30T22:27:00.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
}

async function writeUnterminatedRollout(home: string) {
  const directory = NodePath.join(home, ".codex", "sessions", "2026", "07", "30");
  await NodeFSP.mkdir(directory, { recursive: true });
  const path = NodePath.join(directory, `rollout-2026-07-30T15-25-54-${SESSION_ID}.jsonl`);
  await NodeFSP.writeFile(
    path,
    [
      {
        timestamp: "2026-07-30T22:25:54.039Z",
        type: "session_meta",
        payload: {
          id: SESSION_ID,
          cwd: "/work/phase2-router",
          originator: "codex_exec",
          source: "exec",
        },
      },
      {
        timestamp: "2026-07-30T22:25:55.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: PROMPT },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  return path;
}

describe("enrichHistoricalCodexCliActivities", () => {
  it("recovers the exact rollout for the real cd + nohup + relative -C launch shape", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-history-"));
    await writeRollout(home);

    const [enriched] = await enrichHistoricalCodexCliActivities({
      activities: [
        activity(
          `cd /work/phase2-router && nohup codex exec -C . -m gpt-5.6-sol "${PROMPT}" > /tmp/codex.log 2>&1 &`,
        ),
      ],
      parentCwd: "/work/parent",
      codexHome: NodePath.join(home, ".codex"),
      nowMs: Date.parse("2026-07-30T23:00:00.000Z"),
    });

    expect(enriched?.payload).toMatchObject({
      codexCliHistorySessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      codexCliRolloutStatus: "completed",
      codexCliRolloutStatusAt: "2026-07-30T22:27:00.000Z",
    });
  });

  it("uses the legacy itemId join key from persisted tool.updated and tool.completed rows", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-history-"));
    await writeRollout(home);
    const command =
      `cd /work/phase2-router && nohup codex exec -C . -m gpt-5.6-sol "${PROMPT}" ` +
      "> /tmp/codex.log 2>&1 &";

    const enriched = await enrichHistoricalCodexCliActivities({
      activities: [
        activity(command, { legacyItemId: true }),
        {
          ...activity(command, { legacyItemId: true, kind: "tool.completed" }),
          id: EventId.make("launch-completed"),
          createdAt: "2026-07-30T22:25:53.000Z",
        },
      ],
      parentCwd: "/work/parent",
      codexHome: NodePath.join(home, ".codex"),
      nowMs: Date.parse("2026-07-30T23:00:00.000Z"),
    });

    expect(enriched[0]?.payload).toMatchObject({
      itemId: "toolu_launch",
      codexCliHistorySessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      codexCliRolloutStatus: "completed",
    });
  });

  it("timestamps the one-day stale cutoff when a linked rollout has no terminal record", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-history-"));
    await writeUnterminatedRollout(home);

    const [enriched] = await enrichHistoricalCodexCliActivities({
      activities: [
        activity(
          `cd /work/phase2-router && nohup codex exec -C . "${PROMPT}" > /tmp/codex.log 2>&1 &`,
        ),
      ],
      parentCwd: "/work/parent",
      codexHome: NodePath.join(home, ".codex"),
      nowMs: Date.parse("2026-08-01T23:00:00.000Z"),
      probeRolloutLiveness: async () => null,
    });

    expect(enriched?.payload).toMatchObject({
      codexCliRolloutStatus: "stopped",
      codexCliRolloutStatusAt: "2026-07-31T22:25:52.878Z",
    });
  });

  it("stops a recent non-terminal rollout once its exact file has no live writer", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-history-"));
    const path = await writeUnterminatedRollout(home);
    const probedPaths: string[] = [];

    const [enriched] = await enrichHistoricalCodexCliActivities({
      activities: [
        activity(
          `cd /work/phase2-router && nohup codex exec -C . "${PROMPT}" > /tmp/codex.log 2>&1 &`,
        ),
      ],
      parentCwd: "/work/parent",
      codexHome: NodePath.join(home, ".codex"),
      nowMs: Date.parse("2026-07-30T23:00:00.000Z"),
      probeRolloutLiveness: async (rolloutPath) => {
        probedPaths.push(rolloutPath);
        return false;
      },
    });

    expect(probedPaths).toEqual([path]);
    expect(enriched?.payload).toMatchObject({
      codexCliRolloutStatus: "stopped",
      codexCliRolloutStatusAt: "2026-07-30T23:00:00.000Z",
      codexCliRolloutLiveness: "closed",
    });
  });

  it("keeps a recent non-terminal rollout running while its exact file has a live writer", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-history-"));
    await writeUnterminatedRollout(home);

    const [enriched] = await enrichHistoricalCodexCliActivities({
      activities: [
        activity(
          `cd /work/phase2-router && nohup codex exec -C . "${PROMPT}" > /tmp/codex.log 2>&1 &`,
        ),
      ],
      parentCwd: "/work/parent",
      codexHome: NodePath.join(home, ".codex"),
      nowMs: Date.parse("2026-07-30T23:00:00.000Z"),
      probeRolloutLiveness: async () => true,
    });

    expect(enriched?.payload).toMatchObject({
      codexCliRolloutStatus: "running",
      codexCliRolloutStatusAt: "2026-07-30T23:00:00.000Z",
      codexCliRolloutLiveness: "live",
    });
  });

  it("leaves an unmatched historical launch untouched", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-codex-history-"));
    const original = activity(`codex exec "${PROMPT}"`);
    const [enriched] = await enrichHistoricalCodexCliActivities({
      activities: [original],
      parentCwd: "/work/parent",
      codexHome: NodePath.join(home, ".codex"),
    });
    expect(enriched).toBe(original);
  });
});
