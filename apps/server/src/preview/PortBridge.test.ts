import { it } from "@effect/vitest";
import { ThreadId } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as PortBridge from "./PortBridge.ts";
import * as PortScanner from "./PortScanner.ts";

const scannerLayer = Layer.succeed(PortScanner.PortDiscovery, {
  scan: () =>
    Effect.succeed([
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173",
        processName: "vite",
        pid: 123,
        terminal: null,
      },
    ]),
  subscribe: () => Effect.void,
  retain: Effect.void,
  registerTerminalProcesses: () => Effect.void,
  unregisterTerminal: () => Effect.void,
});

const testLayer = PortBridge.layer.pipe(Layer.provide(scannerLayer));

it.layer(testLayer)("PreviewPortBridgeRegistry", (it) => {
  it.effect("issues a scoped ticket for a listening port", () =>
    Effect.gen(function* () {
      const registry = yield* PortBridge.PreviewPortBridgeRegistry;
      const ticket = yield* registry.issue({
        threadId: ThreadId.make("thread-1"),
        port: 5173,
      });
      expect(ticket.ticket.length).toBeGreaterThan(20);
      expect(ticket.port).toBe(5173);
      expect(yield* registry.resolve(ticket.ticket)).toMatchObject({
        threadId: "thread-1",
        port: 5173,
      });
    }),
  );

  it.effect("rejects a port that is not listening", () =>
    Effect.gen(function* () {
      const registry = yield* PortBridge.PreviewPortBridgeRegistry;
      const error = yield* Effect.flip(
        registry.issue({ threadId: ThreadId.make("thread-2"), port: 8080 }),
      );
      expect(error._tag).toBe("PreviewPortUnavailableError");
      expect(error.port).toBe(8080);
    }),
  );
});
