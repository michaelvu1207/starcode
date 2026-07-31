import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import {
  buildFleetSessionBootstrapInstructions,
  resolveFleetSessionBootstrapInstructions,
} from "./FleetSessionBootstrap.ts";

const node = (environmentId: string, label: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
});

describe("FleetSessionBootstrap", () => {
  it("renders a deterministic, credential-free fleet routing prompt", () => {
    const prompt = buildFleetSessionBootstrapInstructions({
      localNode: node("node-local", "Michael's MacBook Pro"),
      reachableNodes: [
        node("node-z", "SimForge"),
        node("node-local", "Michael's MacBook Pro"),
        node("node-a", "Path <PC>"),
        node("node-z", "duplicate ignored"),
      ],
      thread: {
        threadId: ThreadId.make("thread-42"),
        title: "Implement unified routing",
      },
      project: {
        slug: "starcode",
        title: "StarCode",
        notes: "Route existing threads by id.",
      },
      orchestrator: {
        role: "project",
      },
    });

    NodeAssert.match(prompt, /This session started on Michael&apos;s MacBook Pro \(node-local\)/u);
    NodeAssert.match(prompt, /Current thread: Implement unified routing \(thread-42\)/u);
    NodeAssert.match(prompt, /Current project: StarCode \(starcode\)/u);
    NodeAssert.match(prompt, /Route existing threads by id/u);
    NodeAssert.match(prompt, /This thread is its project's orchestrator/u);
    NodeAssert.match(prompt, /Path &lt;PC&gt; \(node-a\)[\s\S]*SimForge \(node-z\)/u);
    NodeAssert.doesNotMatch(prompt, /duplicate ignored/u);
    NodeAssert.match(prompt, /`threads_list` discovers threads across every reachable node/u);
    NodeAssert.match(prompt, /`thread_read` reads an existing thread by thread id/u);
    NodeAssert.match(prompt, /`thread_send` sends a message to an existing thread by thread id/u);
    NodeAssert.match(prompt, /`thread_create` creates a thread/u);
    NodeAssert.match(prompt, /Never ask the user which machine owns an existing thread/u);
  });

  it("escapes metadata and redacts credential-like project notes", () => {
    const prompt = buildFleetSessionBootstrapInstructions({
      localNode: node("node-local", "Mac <local>"),
      reachableNodes: [node("node-remote", "Remote & shared")],
      thread: {
        threadId: ThreadId.make("thread-secret"),
        title: "Fix <routing>",
      },
      project: {
        title: "Fleet & Thread",
        notes: [
          "Use <thread ids>.",
          "Authorization: Bearer fleet-credential-sentinel",
          "api_key=sk-secret-sentinel-value",
          "remote=https://alice:password@example.test/path",
        ].join("\n"),
      },
      orchestrator: {
        role: "worker",
        designatedThreadId: ThreadId.make("thread-orchestrator"),
      },
    });

    NodeAssert.match(prompt, /Mac &lt;local&gt;/u);
    NodeAssert.match(prompt, /Remote &amp; shared/u);
    NodeAssert.match(prompt, /Fix &lt;routing&gt;/u);
    NodeAssert.match(prompt, /Use &lt;thread ids&gt;/u);
    NodeAssert.match(prompt, /Bearer \[REDACTED\]/u);
    NodeAssert.match(prompt, /api_key=\[REDACTED\]/u);
    NodeAssert.match(prompt, /https:\/\/\[REDACTED\]@example\.test/u);
    NodeAssert.doesNotMatch(
      prompt,
      /fleet-credential-sentinel|sk-secret-sentinel-value|alice:password/u,
    );
    NodeAssert.match(prompt, /designated orchestrator is thread-orchestrator/u);
  });

  it.effect("degrades to no bootstrap when snapshot discovery fails", () =>
    Effect.gen(function* () {
      const prompt = yield* resolveFleetSessionBootstrapInstructions(
        () => Effect.die(new Error("authorization=Bearer should-not-be-logged")),
        { threadId: ThreadId.make("thread-1") },
      );

      NodeAssert.equal(prompt, undefined);
    }),
  );
});
