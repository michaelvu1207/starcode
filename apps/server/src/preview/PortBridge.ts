import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import {
  AuthOrchestrationOperateScope,
  PreviewPortUnavailableError,
  type PreviewPortBridgeTicket,
  type PreviewPortBridgeTicketInput,
} from "@starcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { CloseEvent } from "effect/unstable/socket/Socket";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as PortScanner from "./PortScanner.ts";

const TICKET_TTL_MS = 4 * 60 * 60 * 1_000;

interface TicketRecord {
  readonly port: number;
  readonly threadId: string;
  readonly expiresAtMs: number;
}

export class PreviewPortBridgeTicketError extends Schema.TaggedErrorClass<PreviewPortBridgeTicketError>()(
  "PreviewPortBridgeTicketError",
  {
    reason: Schema.Literals(["missing", "invalid", "expired"]),
  },
) {}

export class PreviewPortBridgeConnectError extends Schema.TaggedErrorClass<PreviewPortBridgeConnectError>()(
  "PreviewPortBridgeConnectError",
  {
    port: Schema.Int,
    cause: Schema.Defect(),
  },
) {}

export class PreviewPortBridgeRegistry extends Context.Service<
  PreviewPortBridgeRegistry,
  {
    readonly issue: (
      input: PreviewPortBridgeTicketInput,
    ) => Effect.Effect<PreviewPortBridgeTicket, PreviewPortUnavailableError>;
    readonly resolve: (ticket: string) => Effect.Effect<TicketRecord, PreviewPortBridgeTicketError>;
  }
>()("starcode/preview/PortBridge/PreviewPortBridgeRegistry") {}

export const make = Effect.gen(function* PreviewPortBridgeRegistryMake() {
  const discovery = yield* PortScanner.PortDiscovery;
  const tickets = yield* Ref.make<ReadonlyMap<string, TicketRecord>>(new Map());

  const issue: PreviewPortBridgeRegistry["Service"]["issue"] = Effect.fn(
    "PreviewPortBridgeRegistry.issue",
  )(function* (input) {
    const servers = yield* discovery.scan();
    if (!servers.some((server) => server.port === input.port)) {
      return yield* new PreviewPortUnavailableError({ port: input.port });
    }
    const ticket = NodeCrypto.randomUUID();
    const now = yield* DateTime.now;
    const expiresAtMs = DateTime.toEpochMillis(now) + TICKET_TTL_MS;
    yield* Ref.update(tickets, (current) => {
      const next = new Map(current);
      next.set(ticket, {
        port: input.port,
        threadId: input.threadId,
        expiresAtMs,
      });
      return next;
    });
    return {
      ticket,
      port: input.port,
      expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: TICKET_TTL_MS })),
    };
  });

  const resolve: PreviewPortBridgeRegistry["Service"]["resolve"] = Effect.fn(
    "PreviewPortBridgeRegistry.resolve",
  )(function* (ticket) {
    const record = (yield* Ref.get(tickets)).get(ticket);
    if (!record) {
      return yield* new PreviewPortBridgeTicketError({ reason: "invalid" });
    }
    if (record.expiresAtMs <= (yield* Clock.currentTimeMillis)) {
      yield* Ref.update(tickets, (current) => {
        const next = new Map(current);
        next.delete(ticket);
        return next;
      });
      return yield* new PreviewPortBridgeTicketError({ reason: "expired" });
    }
    return record;
  });

  return PreviewPortBridgeRegistry.of({ issue, resolve });
});

export const layer = Layer.effect(PreviewPortBridgeRegistry, make);

const connectLoopback = (port: number) =>
  Effect.callback<NodeNet.Socket, PreviewPortBridgeConnectError>((resume) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    const onConnect = () => {
      cleanup();
      resume(Effect.succeed(socket));
    };
    const onError = (cause: Error) => {
      cleanup();
      socket.destroy();
      resume(Effect.fail(new PreviewPortBridgeConnectError({ port, cause })));
    };
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return Effect.sync(() => {
      cleanup();
      socket.destroy();
    });
  });

const bridgeSocket = Effect.fn("PreviewPortBridge.bridgeSocket")(function* (remotePort: number) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webSocket = yield* request.upgrade;
  const writeWebSocket = yield* webSocket.writer;
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const tcpSocket = yield* Effect.acquireRelease(connectLoopback(remotePort), (socket) =>
    Effect.sync(() => socket.destroy()),
  );

  yield* Effect.callback<void>((resume) => {
    let finished = false;
    let writeChain = Promise.resolve();
    const finish = () => {
      if (finished) return;
      finished = true;
      resume(Effect.void);
    };
    const onData = (chunk: Buffer) => {
      writeChain = writeChain
        .then(() => runPromise(writeWebSocket(new Uint8Array(chunk))))
        .catch(() => {
          tcpSocket.destroy();
        });
    };
    const onEnd = () => finish();
    const onError = () => finish();
    tcpSocket.on("data", onData);
    tcpSocket.once("end", onEnd);
    tcpSocket.once("close", onEnd);
    tcpSocket.once("error", onError);

    const readFiber = runFork(
      webSocket
        .runRaw((chunk) =>
          Effect.sync(() => {
            const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
            tcpSocket.write(bytes);
          }),
        )
        .pipe(Effect.catch(() => Effect.void)),
    );
    readFiber.addObserver(finish);

    return Effect.sync(() => {
      tcpSocket.off("data", onData);
      tcpSocket.off("end", onEnd);
      tcpSocket.off("close", onEnd);
      tcpSocket.off("error", onError);
      tcpSocket.destroy();
      runFork(writeWebSocket(new CloseEvent())).addObserver(() => undefined);
    });
  });
});

export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* PreviewPortBridgeRegistry;
    return HttpRouter.add(
      "GET",
      "/api/preview/port-bridge",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const ticket = authorization?.startsWith("PreviewBridge ")
          ? authorization.slice("PreviewBridge ".length)
          : null;
        if (!ticket) {
          return HttpServerResponse.text("Missing preview bridge ticket.", { status: 401 });
        }
        const record = yield* registry.resolve(ticket).pipe(Effect.option);
        if (record._tag === "None") {
          return HttpServerResponse.text("Invalid or expired preview bridge ticket.", {
            status: 401,
          });
        }
        yield* bridgeSocket(record.value.port).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("preview port bridge closed", {
              cause,
              port: record.value.port,
              threadId: record.value.threadId,
              requiredScope: AuthOrchestrationOperateScope,
            }),
          ),
        );
        return HttpServerResponse.empty();
      }),
    );
  }),
);
