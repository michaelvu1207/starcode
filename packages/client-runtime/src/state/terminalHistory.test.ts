import { EnvironmentId, ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  fetchEnvironmentHistoryImports,
  requestEnvironmentHistoryFork,
} from "./terminalHistory.ts";

const prepared: PreparedConnection = {
  environmentId: EnvironmentId.make("environment-alpha"),
  label: "Alpha",
  httpBaseUrl: "https://alpha.example.test/",
  socketUrl: "wss://alpha.example.test/ws",
  httpAuthorization: null,
  target: new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-alpha"),
    label: "Alpha",
    httpBaseUrl: "https://alpha.example.test/",
    wsBaseUrl: "wss://alpha.example.test/",
  }),
};

const forkRecord = {
  threadId: "thread-fork",
  sourceThreadId: "thread-source",
  sourceTitle: "Source thread",
  sourceSessionId: "session-source",
  provider: "pi",
  projectId: "project-source",
  forkedAt: "2026-08-04T12:00:00.000Z",
  historySessionId: null,
  startedAt: null,
};

const respondWith = (body: unknown) => {
  const requests: Array<{ readonly url: string; readonly method: string }> = [];
  const layer = remoteHttpClientLayer((input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    });
    return Promise.resolve(Response.json(body));
  });
  return { layer, requests };
};

describe("terminal history Pi fork provenance", () => {
  it.effect("decodes Pi provenance from the environment imports endpoint", () => {
    const response = respondWith({ imports: [], forks: [forkRecord] });
    return Effect.gen(function* () {
      const page = yield* fetchEnvironmentHistoryImports({
        prepared,
        signer: Option.none(),
      });

      expect(page.forks?.[0]?.provider).toBe("pi");
      expect(response.requests).toEqual([
        { url: "https://alpha.example.test/api/history/imports", method: "GET" },
      ]);
    }).pipe(Effect.provide(response.layer));
  });

  it.effect("decodes a Pi fork result from the environment fork endpoint", () => {
    const response = respondWith({
      threadId: "thread-fork",
      sourceThreadId: "thread-source",
      projectId: "project-source",
      title: "Source thread (fork)",
      provider: "pi",
      sourceSessionId: "session-source",
    });
    return Effect.gen(function* () {
      const result = yield* requestEnvironmentHistoryFork({
        prepared,
        signer: Option.none(),
        threadId: ThreadId.make("thread-source"),
        request: {},
      });

      expect(result).toMatchObject({
        threadId: "thread-fork",
        sourceThreadId: "thread-source",
        provider: "pi",
      });
      expect(response.requests).toEqual([
        {
          url: "https://alpha.example.test/api/history/threads/thread-source/fork",
          method: "POST",
        },
      ]);
    }).pipe(Effect.provide(response.layer));
  });
});
