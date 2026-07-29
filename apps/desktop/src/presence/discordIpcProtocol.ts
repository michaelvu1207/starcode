/**
 * Discord's local RPC wire format.
 *
 * Every frame is an 8-byte little-endian header — opcode, then payload byte
 * length — followed by that many bytes of UTF-8 JSON. There is no library
 * dependency here on purpose: the protocol is this paragraph, and the published
 * clients pull in native modules and their own event emitters for it.
 */

export const DISCORD_IPC_OPCODE = {
  handshake: 0,
  frame: 1,
  close: 2,
  ping: 3,
  pong: 4,
} as const;

export const DISCORD_IPC_HEADER_BYTES = 8;

/**
 * Discord drops a connection that sends an oversized frame, and a corrupt
 * header would otherwise have us buffer forever waiting for a length that never
 * arrives. Nothing legitimate approaches this.
 */
export const DISCORD_IPC_MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface DiscordIpcFrame {
  readonly opcode: number;
  readonly payload: unknown;
}

export function encodeDiscordFrame(opcode: number, payload: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.allocUnsafe(DISCORD_IPC_HEADER_BYTES + body.byteLength);
  frame.writeInt32LE(opcode, 0);
  frame.writeInt32LE(body.byteLength, 4);
  body.copy(frame, DISCORD_IPC_HEADER_BYTES);
  return frame;
}

export class DiscordIpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordIpcProtocolError";
  }
}

export interface DiscordFrameDecodeResult {
  readonly frames: ReadonlyArray<DiscordIpcFrame>;
  /** Bytes of a frame that has not fully arrived yet; feed them back in next. */
  readonly rest: Buffer;
}

/**
 * Split a socket read into whole frames.
 *
 * Returns the trailing partial frame rather than throwing on it — a stream
 * boundary can land anywhere, including mid-header.
 */
export function decodeDiscordFrames(buffer: Buffer): DiscordFrameDecodeResult {
  const frames: DiscordIpcFrame[] = [];
  let offset = 0;

  while (buffer.byteLength - offset >= DISCORD_IPC_HEADER_BYTES) {
    const opcode = buffer.readInt32LE(offset);
    const length = buffer.readInt32LE(offset + 4);

    if (length < 0 || length > DISCORD_IPC_MAX_PAYLOAD_BYTES) {
      throw new DiscordIpcProtocolError(`Discord sent a frame of implausible length ${length}.`);
    }

    const end = offset + DISCORD_IPC_HEADER_BYTES + length;
    if (buffer.byteLength < end) {
      break;
    }

    const body = buffer.toString("utf8", offset + DISCORD_IPC_HEADER_BYTES, end);
    let payload: unknown;
    try {
      payload = body.length === 0 ? null : JSON.parse(body);
    } catch (cause) {
      throw new DiscordIpcProtocolError(
        `Discord sent a frame whose payload is not JSON: ${String(cause)}`,
      );
    }
    frames.push({ opcode, payload });
    offset = end;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/**
 * How many `discord-ipc-N` slots to probe. Discord numbers them from 0 and
 * takes the next free one, so a second client (a canary build, a leftover
 * process) pushes the live socket up the range.
 */
const DISCORD_IPC_SOCKET_SLOTS = 10;

/**
 * Sandboxed Linux packages relocate the socket inside the runtime dir rather
 * than at its root. Ordered so a native install wins over a sandboxed one, and
 * applied on Linux only — everywhere else these are forty guaranteed-miss
 * connect attempts on every reconnect.
 */
const LINUX_SANDBOX_SUBDIRECTORIES = [
  "app/com.discordapp.Discord/",
  "app/com.discordapp.DiscordCanary/",
  "snap.discord/",
  "snap.discord-canary/",
  ".flatpak/dev.vencord.Vesktop/xdg-run/",
] as const;

/**
 * Where the Discord client's IPC socket might be, most likely first.
 *
 * Windows uses a named pipe at a fixed path. Everywhere else it is a unix
 * socket in the runtime directory, whose location is only discoverable from the
 * environment — `XDG_RUNTIME_DIR` on Linux, `TMPDIR` on macOS (per-user, not
 * `/tmp`), with the rest as fallbacks for stripped-down environments.
 */
export function discordIpcSocketPaths(input: {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ReadonlyArray<string> {
  if (input.platform === "win32") {
    return Array.from(
      { length: DISCORD_IPC_SOCKET_SLOTS },
      (_unused, slot) => `\\\\?\\pipe\\discord-ipc-${slot}`,
    );
  }

  const roots: string[] = [];
  for (const name of ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] as const) {
    const value = input.env[name]?.trim();
    if (value !== undefined && value.length > 0 && !roots.includes(value)) {
      roots.push(value);
    }
  }
  if (!roots.includes("/tmp")) {
    roots.push("/tmp");
  }

  const subdirectories = input.platform === "linux" ? ["", ...LINUX_SANDBOX_SUBDIRECTORIES] : [""];

  const paths: string[] = [];
  for (const root of roots) {
    const base = root.endsWith("/") ? root : `${root}/`;
    for (const subdirectory of subdirectories) {
      for (let slot = 0; slot < DISCORD_IPC_SOCKET_SLOTS; slot += 1) {
        paths.push(`${base}${subdirectory}discord-ipc-${slot}`);
      }
    }
  }
  return paths;
}

export interface DiscordRpcUser {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
}

/**
 * Pull the account out of a READY dispatch, tolerating shape drift.
 *
 * Presence works without it — it only feeds the "publishing to @you" line in
 * settings — so anything unrecognised yields null rather than failing a
 * handshake that otherwise succeeded.
 */
export function readDiscordReadyUser(payload: unknown): DiscordRpcUser | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const user = (data as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;

  const { id, username, global_name: globalName } = user as Record<string, unknown>;
  if (typeof id !== "string" || typeof username !== "string") return null;
  return {
    id,
    username,
    globalName: typeof globalName === "string" && globalName.length > 0 ? globalName : null,
  };
}

export function isDiscordReadyFrame(frame: DiscordIpcFrame): boolean {
  if (frame.opcode !== DISCORD_IPC_OPCODE.frame) return false;
  if (typeof frame.payload !== "object" || frame.payload === null) return false;
  return (frame.payload as { evt?: unknown }).evt === "READY";
}

/** The name a viewer would recognise, preferring Discord's newer display name. */
export function discordAccountName(user: DiscordRpcUser | null): string | null {
  if (user === null) return null;
  return user.globalName ?? user.username;
}
