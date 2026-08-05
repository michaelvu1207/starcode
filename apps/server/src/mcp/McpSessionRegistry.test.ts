import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      // No master designated anywhere — neither in settings nor in the project
      // catalog. These tests are about token lifecycle, and the capability set
      // they assert on is the ordinary-session one.
      Effect.provide(
        Layer.mergeAll(
          serverSettingsLayerTest(),
          Layer.mock(ProjectCatalogRegistry)({ list: Effect.succeed([]) }),
          NodeServices.layer,
        ),
      ),
    );

/** Same wiring, but leaves the lifetime knobs at their shipped defaults. */
const makeDefaultRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({ now })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(
        Layer.mergeAll(
          serverSettingsLayerTest(),
          Layer.mock(ProjectCatalogRegistry)({ list: Effect.succeed([]) }),
          NodeServices.layer,
        ),
      ),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials after inactivity when a caller opts in", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

/**
 * A credential must not expire on its own, on either clock.
 *
 * There is no re-mint path: `issue` is reached only from
 * `ProviderService.startSession`, and the bearer is injected into the agent
 * process at launch. So any expiry — idle or absolute — costs that thread every
 * MCP tool for the rest of its session, with no error until a call fails and
 * nothing the agent can do about it. This pins both halves, because the idle
 * timer was fixed first and the eight-hour cap was left behind doing the same
 * damage on a slower clock.
 *
 * Note this uses the real defaults rather than `makeRegistry`, which pins a
 * 100ms idle window.
 */
it.effect("keeps a credential alive indefinitely by default", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeDefaultRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-idle-default");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Four hours without a single MCP call — well past the old 30-minute window.
    timestamp += 4 * 60 * 60 * 1_000;
    expect(yield* registry.resolve(token)).toBeDefined();

    // And past the old eight-hour absolute cap, which is the overnight run this
    // change exists for.
    timestamp += 5 * 60 * 60 * 1_000;
    expect(yield* registry.resolve(token)).toBeDefined();

    // A year later it is still the same session, because what ends a session is
    // the session ending.
    timestamp += 365 * 24 * 60 * 60 * 1_000;
    expect(yield* registry.resolve(token)).toBeDefined();

    // Revocation is the control actually doing the work.
    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

/**
 * The cap is still available to a caller that asks for one outright — turning
 * the default off must not delete the control. `makeRegistry` pins a 1s
 * lifetime behind a 100ms idle window, so the token is resolved steadily to
 * keep it from being evicted for idleness instead: what expires it here has to
 * be the lifetime, or the test proves nothing.
 */
it.effect("still honours an explicit maximum lifetime", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-capped"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    for (let elapsed = 0; elapsed < 900; elapsed += 50) {
      timestamp += 50;
      expect(yield* registry.resolve(token)).toBeDefined();
    }

    timestamp += 200;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
