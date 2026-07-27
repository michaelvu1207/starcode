/**
 * Who a rename says named the thread.
 *
 * Fork-owned. The rule is one line in the decider and easy to break from either
 * side, and both directions of breakage are silent:
 *
 * - If an omitted source stopped defaulting to `manual`, every rename a person
 *   typed would be recorded as automatic, and the next plan would quietly
 *   overwrite it. The client sends no source at all, so this default is the
 *   only thing protecting a human's title.
 * - If provenance were recorded on renames that carry no title, changing a
 *   thread's model or branch would relabel who named it — and a title a person
 *   typed would become overwritable by having touched something unrelated.
 *
 * @module deciderTitleSourceTest
 */
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const thread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  messages: [],
  activities: [],
  proposedPlans: [],
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  deletedAt: null,
  session: null,
} as unknown as OrchestrationThread;

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [
    {
      id: PROJECT_ID,
      title: "alpha",
      workspaceRoot: "/work/alpha",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    } as unknown as OrchestrationReadModel["projects"][number],
  ],
  threads: [thread],
  updatedAt: NOW,
};

/** The decider may plan one event or several; these commands plan exactly one. */
const decideMetaUpdate = (command: Record<string, unknown>) =>
  decideOrchestrationCommand({
    readModel,
    command: {
      type: "thread.meta.update",
      commandId: CommandId.make("command-1"),
      threadId: THREAD_ID,
      ...command,
    } as never,
  }).pipe(
    Effect.map((result) => {
      const event = Array.isArray(result) ? result[0] : result;
      return event as { type: string; payload: { titleSource?: string } };
    }),
    Effect.provide(NodeServices.layer),
  );

it.effect("treats a rename with no stated source as a person's", () =>
  Effect.gen(function* () {
    // The client sends no titleSource, so this default is the only thing
    // standing between a title somebody typed and the next automatic rename.
    const event = yield* decideMetaUpdate({ title: "My own name for this" });
    expect(event.type).toBe("thread.meta-updated");
    expect(event.payload.titleSource).toBe("manual");
  }),
);

it.effect("keeps the source a server-side renamer states", () =>
  Effect.gen(function* () {
    const generated = yield* decideMetaUpdate({ title: "Guessed", titleSource: "generated" });
    expect(generated.payload.titleSource).toBe("generated");

    const fromPlan = yield* decideMetaUpdate({ title: "Plan heading", titleSource: "plan" });
    expect(fromPlan.payload.titleSource).toBe("plan");
  }),
);

it.effect("records no provenance on a rename that carries no title", () =>
  Effect.gen(function* () {
    // Changing the model must not relabel who named the thread — otherwise a
    // title a person typed becomes overwritable by an unrelated edit.
    const event = yield* decideMetaUpdate({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    });
    expect(event.payload.titleSource).toBeUndefined();
  }),
);
