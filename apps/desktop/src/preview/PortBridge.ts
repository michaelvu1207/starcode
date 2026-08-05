import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import { NodeWS } from "@effect/platform-node/NodeSocket";
import type {
  DesktopPreviewPortBridgeOpenInput,
  DesktopPreviewPortBridgeOpenResult,
} from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

interface BridgeEntry {
  readonly server: NodeNet.Server;
  readonly sockets: Set<NodeNet.Socket>;
  readonly webSockets: Set<InstanceType<typeof NodeWS.WebSocket>>;
}

export class DesktopPreviewPortBridgeError extends Schema.TaggedErrorClass<DesktopPreviewPortBridgeError>()(
  "DesktopPreviewPortBridgeError",
  {
    operation: Schema.Literals(["open", "close"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Desktop preview port bridge failed during ${this.operation}.`;
  }
}

export class PreviewPortBridge extends Context.Service<
  PreviewPortBridge,
  {
    readonly open: (
      input: DesktopPreviewPortBridgeOpenInput,
    ) => Effect.Effect<DesktopPreviewPortBridgeOpenResult, DesktopPreviewPortBridgeError>;
    readonly close: (bridgeId: string) => Effect.Effect<void, DesktopPreviewPortBridgeError>;
  }
>()("@starcode/desktop/preview/PortBridge/PreviewPortBridge") {}

const closeEntry = (entry: BridgeEntry) => {
  for (const socket of entry.sockets) socket.destroy();
  for (const webSocket of entry.webSockets) webSocket.close();
  entry.server.close();
};

const listen = (server: NodeNet.Server, port: number) =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const onError = (cause: Error) => {
          cleanup();
          reject(cause);
        };
        const onListening = () => {
          cleanup();
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Preview bridge did not expose a TCP address."));
            return;
          }
          resolve(address.port);
        };
        const cleanup = () => {
          server.off("error", onError);
          server.off("listening", onListening);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host: "127.0.0.1", port });
      }),
    catch: (cause) => new DesktopPreviewPortBridgeError({ operation: "open", cause }),
  });

const messageBytes = (data: unknown): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) return Buffer.concat(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("Preview bridge received an unsupported WebSocket message.");
};

const attachConnection = (
  input: DesktopPreviewPortBridgeOpenInput,
  entry: BridgeEntry,
  localSocket: NodeNet.Socket,
) => {
  entry.sockets.add(localSocket);
  localSocket.pause();

  const tunnelUrl = new URL("/api/preview/port-bridge", input.httpBaseUrl);
  tunnelUrl.protocol = tunnelUrl.protocol === "https:" ? "wss:" : "ws:";
  const webSocket = new NodeWS.WebSocket(tunnelUrl, {
    headers: { authorization: `PreviewBridge ${input.ticket}` },
  });
  entry.webSockets.add(webSocket);

  const dispose = () => {
    entry.sockets.delete(localSocket);
    entry.webSockets.delete(webSocket);
    localSocket.destroy();
    if (webSocket.readyState === NodeWS.WebSocket.OPEN) webSocket.close();
  };

  webSocket.binaryType = "arraybuffer";
  webSocket.once("open", () => localSocket.resume());
  webSocket.on("message", (data) => {
    if (!localSocket.destroyed) localSocket.write(messageBytes(data));
  });
  webSocket.once("close", dispose);
  webSocket.once("error", dispose);
  localSocket.on("data", (data) => {
    if (webSocket.readyState === NodeWS.WebSocket.OPEN) webSocket.send(data, { binary: true });
  });
  localSocket.once("close", dispose);
  localSocket.once("error", dispose);
};

export const make = Effect.gen(function* PreviewPortBridgeMake() {
  const scope = yield* Scope.Scope;
  const bridges = new Map<string, BridgeEntry>();

  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      for (const entry of bridges.values()) closeEntry(entry);
      bridges.clear();
    }),
  );

  const open: PreviewPortBridge["Service"]["open"] = Effect.fn("PreviewPortBridge.open")(
    function* (input) {
      const sockets = new Set<NodeNet.Socket>();
      const webSockets = new Set<InstanceType<typeof NodeWS.WebSocket>>();
      const entry: BridgeEntry = {
        server: NodeNet.createServer((socket) => attachConnection(input, entry, socket)),
        sockets,
        webSockets,
      };

      let localPort: number;
      const preferred = yield* Effect.result(listen(entry.server, input.remotePort));
      if (preferred._tag === "Success") {
        localPort = preferred.success;
      } else {
        localPort = yield* listen(entry.server, 0);
      }

      const bridgeId = NodeCrypto.randomUUID();
      bridges.set(bridgeId, entry);
      return {
        bridgeId,
        localPort,
        baseUrl: `${input.protocol}://localhost:${localPort}`,
      };
    },
  );

  const close: PreviewPortBridge["Service"]["close"] = Effect.fn("PreviewPortBridge.close")(
    function* (bridgeId) {
      const entry = bridges.get(bridgeId);
      if (!entry) return;
      bridges.delete(bridgeId);
      yield* Effect.sync(() => closeEntry(entry));
    },
  );

  return PreviewPortBridge.of({ open, close });
});

export const layer = Layer.effect(PreviewPortBridge, make);
