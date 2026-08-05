import { it } from "@effect/vitest";
import { EnvironmentId } from "@starcode/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as PortBridge from "./PortBridge.ts";

it.layer(PortBridge.layer)("PreviewPortBridge", (it) => {
  it.effect("opens and closes a loopback bridge listener", () =>
    Effect.gen(function* () {
      const bridge = yield* PortBridge.PreviewPortBridge;
      const opened = yield* bridge.open({
        environmentId: EnvironmentId.make("environment-1"),
        httpBaseUrl: "http://127.0.0.1:3773",
        ticket: "test-ticket",
        remotePort: 51_973,
        protocol: "http",
      });
      expect(opened.localPort).toBeGreaterThan(0);
      expect(opened.baseUrl).toBe(`http://localhost:${opened.localPort}`);
      yield* bridge.close(opened.bridgeId);
      yield* bridge.close(opened.bridgeId);
    }),
  );
});
