import * as NodeNet from "node:net";

import type { DiscordActivity } from "./discordActivity.ts";
import {
  DISCORD_IPC_OPCODE,
  decodeDiscordFrames,
  discordAccountName,
  encodeDiscordFrame,
  isDiscordReadyFrame,
  readDiscordReadyUser,
  type DiscordRpcUser,
} from "./discordIpcProtocol.ts";

/**
 * A live RPC session with the local Discord client.
 *
 * Promise-shaped rather than Effect-shaped because it is a thin wrapper over a
 * callback-driven socket; the Effect service above it owns the retry policy,
 * scheduling, and everything else worth expressing in Effect.
 */
export interface DiscordRpcConnection {
  readonly accountName: string | null;
  readonly user: DiscordRpcUser | null;
  readonly setActivity: (activity: DiscordActivity | null) => Promise<void>;
  readonly close: () => void;
  readonly isOpen: () => boolean;
}

export class DiscordRpcConnectError extends Error {
  readonly socketPath: string;

  constructor(message: string, socketPath: string) {
    super(message);
    this.name = "DiscordRpcConnectError";
    this.socketPath = socketPath;
  }
}

/** How long to wait for a READY dispatch before giving up on a socket. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

export interface ConnectDiscordRpcInput {
  readonly socketPath: string;
  readonly clientId: string;
  readonly processId: number;
  readonly handshakeTimeoutMs?: number;
}

export function connectDiscordRpc(input: ConnectDiscordRpcInput): Promise<DiscordRpcConnection> {
  return new Promise<DiscordRpcConnection>((resolve, reject) => {
    const socket = NodeNet.createConnection({ path: input.socketPath });
    socket.setNoDelay(true);

    let buffer: Buffer = Buffer.alloc(0);
    let settled = false;
    let open = true;
    let nonce = 0;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      open = false;
      socket.destroy();
      reject(new DiscordRpcConnectError(message, input.socketPath));
    };

    // The socket's own idle timer rather than a global one: a socket that
    // accepts the connection and then says nothing is the failure mode that
    // would otherwise hang the presence loop forever — a stale socket file, or
    // another program squatting the path.
    socket.setTimeout(input.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    socket.on("timeout", () => {
      fail("Discord accepted the connection but never completed the handshake.");
    });

    socket.on("error", (cause) => {
      open = false;
      fail(cause.message);
    });

    socket.on("close", () => {
      open = false;
      fail("Discord closed the connection before the handshake completed.");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frames;
      try {
        ({ frames, rest: buffer } = decodeDiscordFrames(buffer));
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause));
        return;
      }

      for (const frame of frames) {
        if (frame.opcode === DISCORD_IPC_OPCODE.ping) {
          socket.write(encodeDiscordFrame(DISCORD_IPC_OPCODE.pong, frame.payload));
          continue;
        }
        if (frame.opcode === DISCORD_IPC_OPCODE.close) {
          fail("Discord rejected the connection.");
          return;
        }
        if (settled || !isDiscordReadyFrame(frame)) {
          continue;
        }

        settled = true;
        // Past the handshake there is no deadline: an established session is
        // idle whenever nothing changes, which is most of the time.
        socket.setTimeout(0);
        socket.removeAllListeners("timeout");
        const user = readDiscordReadyUser(frame.payload);
        // Past the handshake, a socket error is no longer this promise's
        // problem — it just means the session is over, which `isOpen` reports
        // and the presence loop reacts to on its next tick.
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        socket.on("error", () => {
          open = false;
        });
        socket.on("close", () => {
          open = false;
        });

        resolve({
          accountName: discordAccountName(user),
          user,
          isOpen: () => open && !socket.destroyed,
          close: () => {
            open = false;
            socket.destroy();
          },
          setActivity: (activity) =>
            new Promise<void>((resolveWrite, rejectWrite) => {
              if (!open || socket.destroyed) {
                rejectWrite(new Error("The Discord RPC connection is closed."));
                return;
              }
              nonce += 1;
              const command = encodeDiscordFrame(DISCORD_IPC_OPCODE.frame, {
                cmd: "SET_ACTIVITY",
                nonce: `${input.processId}-${nonce}`,
                args: {
                  pid: input.processId,
                  // Null clears the presence, which is what the user asked for
                  // when they turn the setting off with Discord still running.
                  activity: activity ?? undefined,
                },
              });
              socket.write(command, (cause) => {
                if (cause) rejectWrite(cause);
                else resolveWrite();
              });
            }),
        });
      }
    });

    socket.on("connect", () => {
      socket.write(
        encodeDiscordFrame(DISCORD_IPC_OPCODE.handshake, { v: 1, client_id: input.clientId }),
      );
    });
  });
}
