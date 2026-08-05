import { assert, describe, it } from "@effect/vitest";
import { EventEmitter } from "node:events";
import * as NodeNet from "node:net";

import {
  createResilientNodeHttpServer,
  installHttpClientDisconnectGuard,
  isRecoverableHttpClientDisconnect,
  installRecoverableTransportErrorGuard,
  isRecoverableTransportReset,
} from "./recoverableTransportErrors.ts";

describe("recoverable transport errors", () => {
  it("recognizes only connection resets", () => {
    assert.isTrue(
      isRecoverableTransportReset(
        Object.assign(new Error("reset"), {
          code: "ECONNRESET",
        }),
      ),
    );
    assert.isFalse(
      isRecoverableTransportReset(
        Object.assign(new Error("pipe"), {
          code: "EPIPE",
        }),
      ),
    );
    assert.isFalse(isRecoverableTransportReset("ECONNRESET"));
  });

  it("recognizes client disconnect errors raised while writing an HTTP response", () => {
    for (const code of ["EPIPE", "ECONNRESET"]) {
      assert.isTrue(isRecoverableHttpClientDisconnect(Object.assign(new Error(code), { code })));
    }
    assert.isFalse(
      isRecoverableHttpClientDisconnect(Object.assign(new Error("disk"), { code: "EIO" })),
    );
    assert.isFalse(isRecoverableHttpClientDisconnect("EPIPE"));
  });

  it("keeps unexpected socket errors fatal", () => {
    const socket = new EventEmitter();
    installHttpClientDisconnectGuard(socket);
    const failure = Object.assign(new Error("unexpected socket failure"), { code: "EIO" });

    assert.throws(() => socket.emit("error", failure), failure.message);
  });

  it("absorbs a late broken pipe on a guarded HTTP client socket", () => {
    const socket = new EventEmitter();
    installHttpClientDisconnectGuard(socket);

    assert.doesNotThrow(() => {
      socket.emit("error", Object.assign(new Error("late response write"), { code: "EPIPE" }));
    });
  });

  it("keeps serving after an aborted response reports a late broken pipe", async () => {
    const NodeHttp = await import("node:http");
    const server = createResilientNodeHttpServer(NodeHttp.createServer);
    let resolveAbortedRequest!: () => void;
    const abortedRequest = new Promise<void>((resolve) => {
      resolveAbortedRequest = resolve;
    });

    server.on("request", (request, response) => {
      if (request.url === "/slow") {
        const socket = request.socket;
        socket.once("close", () => {
          assert.doesNotThrow(() => {
            socket.emit(
              "error",
              Object.assign(new Error("write EPIPE after client abort"), { code: "EPIPE" }),
            );
          });
          response.end("late response");
          resolveAbortedRequest();
        });
        return;
      }
      response.end("still alive");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      assert.isNotNull(address);
      assert.notTypeOf(address, "string");
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP server address");
      }

      const client = NodeNet.createConnection(address.port, "127.0.0.1", () => {
        client.write("GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n");
        client.destroy();
      });
      client.on("error", () => {});

      await abortedRequest;
      const responseBody = await new Promise<string>((resolve, reject) => {
        const request = NodeHttp.get(`http://127.0.0.1:${address.port}/ready`, (response) => {
          response.setEncoding("utf8");
          let body = "";
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        });
        request.on("error", reject);
      });
      assert.strictEqual(responseBody, "still alive");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("absorbs a connection reset reported as an uncaught exception", () => {
    const target = new EventEmitter();
    installRecoverableTransportErrorGuard(target);

    assert.doesNotThrow(() => {
      target.emit(
        "uncaughtException",
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      );
    });
  });

  it("rethrows unrelated uncaught exceptions", () => {
    const target = new EventEmitter();
    installRecoverableTransportErrorGuard(target);
    const failure = new Error("logic failure");

    assert.throws(() => target.emit("uncaughtException", failure), failure.message);
  });
});
