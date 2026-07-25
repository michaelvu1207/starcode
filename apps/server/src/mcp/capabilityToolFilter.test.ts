/**
 * Two levels of test, because the gate has two levels.
 *
 * The pure cases pin the filtering rule itself. The transport case drives the
 * real MCP HTTP server end to end with two different bearers and asserts on the
 * `tools/list` a session actually receives — the thing an agent reads and
 * believes.
 */
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FeatureMapRegistry } from "../featureMap/FeatureMapRegistry.ts";
import { ProjectCatalogRegistry } from "../projectCatalog/ProjectCatalogRegistry.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import {
  applyCapabilityToolFilter,
  CAPABILITY_GATED_TOOLS,
  filterToolsListPayload,
  isToolVisible,
} from "./capabilityToolFilter.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PeerThreadReader from "../peers/PeerThreadReader.ts";
import * as PeerThreadWriter from "../peers/PeerThreadWriter.ts";

const ordinary = new Set<McpInvocationContext.McpCapability>(["preview", "peers"]);
const master = new Set<McpInvocationContext.McpCapability>(["preview", "peers", "peers-operate"]);

const toolsListPayload = (...names: ReadonlyArray<string>) => ({
  jsonrpc: "2.0",
  id: 2,
  result: { tools: names.map((name) => ({ name, description: `${name} description` })) },
});

const namesIn = (payload: unknown): ReadonlyArray<string> =>
  ((payload as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools ?? []).map(
    (tool) => tool.name,
  );

const ALL_PEER_TOOLS = [
  "peer_threads_list",
  "peer_thread_read",
  "peer_thread_send",
  "peer_thread_create",
  "peer_thread_dispatch",
] as const;

it("gates the tools that spend another machine's turn, and the ones that rewrite the map", () => {
  expect([...CAPABILITY_GATED_TOOLS.keys()].toSorted()).toEqual([
    "feature_create",
    "feature_link",
    "feature_plan_set",
    "feature_promote",
    "feature_update",
    "peer_thread_create",
    "peer_thread_dispatch",
  ]);
  // Mailbox sends are universal by design; hiding them would take away the one
  // federation write an ordinary agent is meant to have. Reading the feature
  // map is universal for the same reason — an agent that knows which feature it
  // is working on is a better agent.
  expect(CAPABILITY_GATED_TOOLS.has("peer_thread_send")).toBe(false);
  expect(CAPABILITY_GATED_TOOLS.has("feature_map_list")).toBe(false);
});

it("hides the operate tools from a session without the capability", () => {
  const filtered = filterToolsListPayload(toolsListPayload(...ALL_PEER_TOOLS), ordinary);
  expect(filtered).not.toBeNull();
  expect(namesIn(filtered)).toEqual(["peer_threads_list", "peer_thread_read", "peer_thread_send"]);
});

it("leaves a master session's list untouched", () => {
  // `null` means "nothing to change", which is what lets the caller keep the
  // original response object and its headers.
  expect(filterToolsListPayload(toolsListPayload(...ALL_PEER_TOOLS), master)).toBeNull();
});

it("ignores payloads that are not a tool list", () => {
  expect(filterToolsListPayload({ jsonrpc: "2.0", id: 1, result: {} }, ordinary)).toBeNull();
  expect(filterToolsListPayload({ jsonrpc: "2.0", id: 1, error: {} }, ordinary)).toBeNull();
  expect(filterToolsListPayload("not json at all", ordinary)).toBeNull();
  expect(filterToolsListPayload(null, ordinary)).toBeNull();
});

it("keeps tools it does not recognise", () => {
  expect(isToolVisible("preview_click", ordinary)).toBe(true);
  expect(isToolVisible(undefined, ordinary)).toBe(true);
});

it.effect("passes a body it cannot parse through untouched", () =>
  Effect.gen(function* () {
    // A body this module cannot read is a body it must not corrupt.
    const response = HttpServerResponse.text("<<not json>>", { contentType: "application/json" });
    const result = yield* applyCapabilityToolFilter(response, ordinary);
    expect(result).toBe(response);

    const streamed = HttpServerResponse.text("data: {}", { contentType: "text/event-stream" });
    expect(yield* applyCapabilityToolFilter(streamed, ordinary)).toBe(streamed);
  }),
);

it.effect("preserves status and headers when it does rewrite", () =>
  Effect.gen(function* () {
    const response = HttpServerResponse.jsonUnsafe(toolsListPayload(...ALL_PEER_TOOLS), {
      status: 200,
      headers: { "mcp-session-id": "session-abc" },
    });
    const filtered = yield* applyCapabilityToolFilter(response, ordinary);
    expect(filtered.status).toBe(200);
    // The MCP session id rides on this response; losing it would break the
    // client's next request.
    expect(filtered.headers["mcp-session-id"]).toBe("session-abc");
  }),
);

// ── End to end, over the real transport ───────────────────────────────

const environmentId = EnvironmentId.make("environment-filter-test");
const masterThreadId = ThreadId.make("thread-master");
const workerThreadId = ThreadId.make("thread-worker");

const environmentLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

/**
 * A machine with no projects. The registry is real input to the master gate
 * now, so the session registry needs it as well as the handlers do — and
 * "empty" keeps these tests asserting on the settings master alone, which is
 * the split they were written to check.
 */
const emptyProjectCatalogLive = Layer.mock(ProjectCatalogRegistry)({
  list: Effect.succeed([]),
});

/**
 * The MCP layer registers every toolkit, so standing it up means satisfying
 * the handlers' dependencies. None of them are exercised here — this test only
 * ever lists tools, never calls one — so they are mocked to nothing.
 */
const HandlerStubsLive = Layer.mergeAll(
  Layer.mock(PeerThreadReader.PeerThreadReader)({}),
  Layer.mock(PeerThreadWriter.PeerThreadWriter)({}),
  Layer.mock(ProjectionSnapshotQuery)({}),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(FeatureMapRegistry)({}),
  emptyProjectCatalogLive,
  environmentLayer,
);

const RegistryLive = McpSessionRegistry.layer.pipe(
  Layer.provide(environmentLayer),
  Layer.provide(emptyProjectCatalogLive),
  Layer.provide(serverSettingsLayerTest({ workbenchMasterThreadId: masterThreadId })),
);

/** Drives a real `tools/list` for one thread and returns the tool names it sees. */
const listToolsFor = (threadId: ThreadId) =>
  Effect.scoped(
    Effect.gen(function* () {
      // `provideMerge` so the very registry the server authenticates against
      // is the one this test mints from — a second instance would issue tokens
      // the server has never heard of.
      const built = yield* HttpRouter.serve(McpHttpServer.layer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provideMerge(RegistryLive), Layer.provide(HandlerStubsLive), Layer.build);
      const registry = Context.get(built, McpSessionRegistry.McpSessionRegistry);
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const authorization = issued.config.authorizationHeader;
      const httpClient = yield* HttpClient.HttpClient;

      const init = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream", authorization },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"filter-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(init.status).toBe(200);

      const listed = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization,
          "mcp-session-id": init.headers["mcp-session-id"]!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      expect(listed.status).toBe(200);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - Asserting on the raw wire body is the point of this test.
      return namesIn(JSON.parse(yield* listed.text));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer)));

it.effect("an ordinary session is never shown the master-only tools", () =>
  Effect.gen(function* () {
    const tools = yield* listToolsFor(workerThreadId);
    expect(tools).toContain("peer_threads_list");
    expect(tools).toContain("peer_thread_read");
    expect(tools).toContain("peer_thread_send");
    expect(tools).not.toContain("peer_thread_create");
    expect(tools).not.toContain("peer_thread_dispatch");
  }),
);

it.effect("shows every session the project tools, self-filing included", () =>
  Effect.gen(function* () {
    // Over the real transport, so this is also the proof the toolkit is
    // registered at all. `project_file_thread` is visible on purpose: its gate
    // is a branch inside the handler (yours versus someone else's), not a
    // capability that can be expressed by hiding the tool.
    const tools = yield* listToolsFor(workerThreadId);
    expect(tools).toContain("project_list");
    expect(tools).toContain("project_get");
    expect(tools).toContain("project_file_thread");
  }),
);

it.effect("the designated master session is shown all of them", () =>
  Effect.gen(function* () {
    const tools = yield* listToolsFor(masterThreadId);
    expect(tools).toContain("peer_thread_send");
    expect(tools).toContain("peer_thread_create");
    expect(tools).toContain("peer_thread_dispatch");
  }),
);
