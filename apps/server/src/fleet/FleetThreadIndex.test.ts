import { assert, it } from "@effect/vitest";
import { EnvironmentId, FleetNodeName, ProjectCategorySlug, ThreadId } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { FleetThreadIndex, layer } from "./FleetThreadIndex.ts";

it.effect("refreshes, resolves, and does not revise an unchanged index", () =>
  Effect.gen(function* () {
    const index = yield* FleetThreadIndex;
    const alpha = EnvironmentId.make("alpha");
    const entry = {
      threadId: ThreadId.make("thread-1"),
      node: alpha,
      nodeName: FleetNodeName.make("alpha"),
      project: ProjectCategorySlug.make("starcode"),
      title: "Thread one",
      status: "working" as const,
      lastActivityAt: "2026-07-30T00:00:00.000Z",
      createdAt: "2026-07-29T00:00:00.000Z",
      provider: "claude",
      model: "opus",
      branch: null,
    };
    const first = yield* index.refresh([entry], alpha);
    const unchanged = yield* index.refresh([entry], alpha);
    const found = yield* index.lookup(entry.threadId);

    assert.equal(first.revision, 1);
    assert.equal(unchanged.revision, 1);
    assert.equal(first.entries[0]?.project, "starcode");
    assert.isTrue(Option.isSome(found));
    assert.deepEqual(Option.getOrThrow(found), {
      environmentId: alpha,
      node: FleetNodeName.make("alpha"),
      local: true,
    });
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
