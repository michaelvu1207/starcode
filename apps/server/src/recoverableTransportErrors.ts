interface ProcessErrorEmitter {
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
}

interface SocketErrorEmitter {
  on(event: "error", listener: (error: unknown) => void): unknown;
}

interface SocketAcceptingServer {
  on(event: "connection", listener: (socket: SocketErrorEmitter) => void): unknown;
}

export function isRecoverableTransportReset(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ECONNRESET"
  );
}

export function isRecoverableHttpClientDisconnect(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EPIPE" ||
      (error as NodeJS.ErrnoException).code === "ECONNRESET")
  );
}

/**
 * Keep a listener on every accepted HTTP socket for its full lifetime. A
 * client can disappear after its request fiber has been interrupted but while
 * Node is still flushing `ServerResponse.end()`. On that narrow race Node
 * reports EPIPE/ECONNRESET on the socket; the failed client connection should
 * not terminate the process and every in-process provider session with it.
 */
export function installHttpClientDisconnectGuard(socket: SocketErrorEmitter): void {
  socket.on("error", (error) => {
    if (isRecoverableHttpClientDisconnect(error)) {
      return;
    }
    throw error;
  });
}

export function createResilientNodeHttpServer<Server extends SocketAcceptingServer>(
  createServer: () => Server,
): Server {
  const server = createServer();
  server.on("connection", installHttpClientDisconnectGuard);
  return server;
}

/**
 * Node turns an unhandled `error` event on a reset transport socket into an
 * uncaught exception. A peer reset already closes that individual socket; it
 * must not take down the orchestration server and every in-process agent.
 */
export function installRecoverableTransportErrorGuard(target: ProcessErrorEmitter): void {
  target.on("uncaughtException", (error) => {
    if (isRecoverableTransportReset(error)) {
      return;
    }
    throw error;
  });
}
