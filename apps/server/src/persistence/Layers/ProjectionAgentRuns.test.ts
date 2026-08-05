import { HistorySessionId, ThreadId } from "@starcode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionAgentRunRepository } from "../Services/ProjectionAgentRuns.ts";
import { ProjectionAgentRunRepositoryLive } from "./ProjectionAgentRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionAgentRunRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const baseRun = {
  parentThreadId: ThreadId.make("thread-a"),
  provider: "claude" as const,
  agentRunId: "agent-1",
  launchToolUseId: "tool-1",
  taskType: "local_agent",
  agentType: "Explore",
  model: null,
  description: "Inspect ownership",
  status: "running" as const,
  startedAt: "2026-07-30T20:00:00.000Z",
  updatedAt: "2026-07-30T20:00:00.000Z",
  historySessionId: null,
  transcriptState: "pending" as const,
  parentNativeSessionId: "native-parent",
};

layer("ProjectionAgentRunRepository", (it) => {
  it.effect("round-trips exact provider launch options", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionAgentRunRepository;
      const parentThreadId = ThreadId.make("thread-options");
      yield* repository.upsert({
        ...baseRun,
        parentThreadId,
        provider: "pi",
        options: [{ id: "effort", value: "minimal" }],
      });
      const rows = yield* repository.listByParentThreadId(parentThreadId);
      assert.deepEqual(rows[0]?.options, [{ id: "effort", value: "minimal" }]);
    }),
  );

  it.effect(
    "keeps terminal state and monotonic timestamps across duplicate lifecycle updates",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionAgentRunRepository;
        const run = { ...baseRun, parentThreadId: ThreadId.make("thread-monotonic") };
        yield* repository.upsert(run);
        yield* repository.upsert({
          ...run,
          status: "completed",
          updatedAt: "2026-07-30T20:02:00.000Z",
        });
        yield* repository.upsert({
          ...run,
          status: "running",
          startedAt: "2026-07-30T20:01:00.000Z",
          updatedAt: "2026-07-30T20:03:00.000Z",
        });

        const rows = yield* repository.listByParentThreadId(run.parentThreadId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.status, "completed");
        assert.equal(rows[0]?.startedAt, "2026-07-30T20:00:00.000Z");
        assert.equal(rows[0]?.updatedAt, "2026-07-30T20:03:00.000Z");
      }),
  );

  it.effect("preserves the stable spawn description across racing progress upserts", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionAgentRunRepository;
      const run = { ...baseRun, parentThreadId: ThreadId.make("thread-stable-description") };
      yield* repository.upsert(run);
      yield* repository.upsert({
        ...run,
        description: "Usage updated",
        updatedAt: "2026-07-30T20:00:01.000Z",
      });

      const rows = yield* repository.listByParentThreadId(run.parentThreadId);
      assert.equal(rows[0]?.description, "Inspect ownership");
    }),
  );

  it.effect("lists only nonterminal same-task attached agents, including nested runs", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionAgentRunRepository;
      const parentThreadId = ThreadId.make("thread-recovery-list");
      yield* repository.upsert({
        ...baseRun,
        parentThreadId,
        agentRunId: "agent:attached-parent",
        taskType: "attached_agent",
      });
      yield* repository.upsert({
        ...baseRun,
        parentThreadId,
        agentRunId: "agent:attached-nested",
        parentAgentRunId: "agent:attached-parent",
        taskType: "attached_agent",
        status: "paused",
      });
      yield* repository.upsert({
        ...baseRun,
        parentThreadId,
        agentRunId: "agent:already-finished",
        taskType: "attached_agent",
        status: "completed",
      });
      yield* repository.upsert({
        ...baseRun,
        parentThreadId,
        agentRunId: "agent:native",
        taskType: "local_agent",
      });

      const rows = yield* repository.listNonterminalAttached();
      assert.deepEqual(
        rows.map((row) => ({ id: row.agentRunId, parent: row.parentAgentRunId ?? null })),
        [
          { id: "agent:attached-nested", parent: "agent:attached-parent" },
          { id: "agent:attached-parent", parent: null },
        ],
      );
    }),
  );

  it.effect("scopes identical run ids by parent thread and provider", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionAgentRunRepository;
      const run = { ...baseRun, parentThreadId: ThreadId.make("thread-scope-a") };
      const otherThreadId = ThreadId.make("thread-scope-b");
      yield* repository.upsert(run);
      yield* repository.upsert({
        ...run,
        parentThreadId: otherThreadId,
      });
      yield* repository.upsert({
        ...run,
        provider: "codex",
        taskType: "codex_cli",
      });

      assert.equal((yield* repository.listByParentThreadId(run.parentThreadId)).length, 2);
      assert.equal((yield* repository.listByParentThreadId(otherThreadId)).length, 1);
    }),
  );

  it.effect("does not allow one native history to be owned by two runs", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionAgentRunRepository;
      const run = { ...baseRun, parentThreadId: ThreadId.make("thread-owner-a") };
      const otherThreadId = ThreadId.make("thread-owner-b");
      const historySessionId = HistorySessionId.make("0123456789abcdef0123456789abcdef");
      yield* repository.upsert(run);
      yield* repository.upsert({
        ...run,
        parentThreadId: otherThreadId,
        agentRunId: "agent-2",
        launchToolUseId: "tool-2",
      });
      yield* repository.replaceHistoryLink({
        parentThreadId: run.parentThreadId,
        provider: run.provider,
        agentRunId: run.agentRunId,
        historySessionId,
        transcriptState: "linked",
      });

      const conflict = yield* Effect.exit(
        repository.replaceHistoryLink({
          parentThreadId: otherThreadId,
          provider: "claude",
          agentRunId: "agent-2",
          historySessionId,
          transcriptState: "linked",
        }),
      );
      assert.equal(conflict._tag, "Failure");
    }),
  );

  it.effect("clears a stale history handle when the transcript becomes unavailable", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionAgentRunRepository;
      const run = { ...baseRun, parentThreadId: ThreadId.make("thread-stale-link") };
      yield* repository.upsert(run);
      yield* repository.replaceHistoryLink({
        parentThreadId: run.parentThreadId,
        provider: run.provider,
        agentRunId: run.agentRunId,
        historySessionId: HistorySessionId.make("fedcba9876543210fedcba9876543210"),
        transcriptState: "linked",
      });
      yield* repository.replaceHistoryLink({
        parentThreadId: run.parentThreadId,
        provider: run.provider,
        agentRunId: run.agentRunId,
        historySessionId: null,
        transcriptState: "unavailable",
      });

      const rows = yield* repository.listByParentThreadId(run.parentThreadId);
      assert.isNull(rows[0]?.historySessionId);
      assert.equal(rows[0]?.transcriptState, "unavailable");
    }),
  );
});
