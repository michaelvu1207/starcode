import { describe, expect, it } from "vite-plus/test";

import {
  DISCORD_IPC_HEADER_BYTES,
  DISCORD_IPC_OPCODE,
  DiscordIpcProtocolError,
  decodeDiscordFrames,
  discordAccountName,
  discordIpcSocketPaths,
  encodeDiscordFrame,
  isDiscordReadyFrame,
  readDiscordReadyUser,
} from "./discordIpcProtocol.ts";

describe("encodeDiscordFrame", () => {
  it("writes a little-endian opcode and byte length ahead of the JSON body", () => {
    const frame = Buffer.from(encodeDiscordFrame(DISCORD_IPC_OPCODE.handshake, { v: 1 }));
    const body = JSON.stringify({ v: 1 });

    expect(frame.readInt32LE(0)).toBe(DISCORD_IPC_OPCODE.handshake);
    expect(frame.readInt32LE(4)).toBe(Buffer.byteLength(body));
    expect(frame.toString("utf8", DISCORD_IPC_HEADER_BYTES)).toBe(body);
  });

  it("counts bytes, not characters", () => {
    // A length in characters would truncate the payload and desynchronize the
    // stream for every frame after it.
    const frame = Buffer.from(encodeDiscordFrame(DISCORD_IPC_OPCODE.frame, { details: "3 ✦" }));
    const { frames, rest } = decodeDiscordFrames(frame);

    expect(rest.byteLength).toBe(0);
    expect(frames[0]?.payload).toEqual({ details: "3 ✦" });
  });
});

describe("decodeDiscordFrames", () => {
  it("returns every whole frame in one read", () => {
    const buffer = Buffer.concat([
      encodeDiscordFrame(DISCORD_IPC_OPCODE.frame, { evt: "READY" }),
      encodeDiscordFrame(DISCORD_IPC_OPCODE.ping, { nonce: "1" }),
    ]);

    const { frames, rest } = decodeDiscordFrames(buffer);

    expect(frames).toHaveLength(2);
    expect(frames[1]?.opcode).toBe(DISCORD_IPC_OPCODE.ping);
    expect(rest.byteLength).toBe(0);
  });

  it("hands back a partial frame instead of consuming it", () => {
    const whole = Buffer.from(encodeDiscordFrame(DISCORD_IPC_OPCODE.frame, { evt: "READY" }));

    for (const cut of [3, DISCORD_IPC_HEADER_BYTES, whole.byteLength - 1]) {
      const { frames, rest } = decodeDiscordFrames(whole.subarray(0, cut));
      expect(frames).toHaveLength(0);
      expect(rest.byteLength).toBe(cut);

      // Feeding the remainder back in completes the frame, which is exactly
      // what the socket's data handler does.
      const resumed = decodeDiscordFrames(Buffer.concat([rest, whole.subarray(cut)]));
      expect(resumed.frames).toHaveLength(1);
    }
  });

  it("refuses an implausible length rather than buffering forever", () => {
    const header = Buffer.alloc(DISCORD_IPC_HEADER_BYTES);
    header.writeInt32LE(DISCORD_IPC_OPCODE.frame, 0);
    header.writeInt32LE(1_000_000_000, 4);

    expect(() => decodeDiscordFrames(header)).toThrow(DiscordIpcProtocolError);
  });
});

describe("discordIpcSocketPaths", () => {
  it("uses named pipes on Windows and ignores the environment", () => {
    const paths = discordIpcSocketPaths({ platform: "win32", env: { TMPDIR: "/tmp/ignored" } });

    expect(paths[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
    expect(paths).toHaveLength(10);
    expect(paths.every((path) => path.startsWith("\\\\?\\pipe\\"))).toBe(true);
  });

  it("probes every slot, because a second Discord client takes slot 0", () => {
    const paths = discordIpcSocketPaths({ platform: "darwin", env: { TMPDIR: "/var/t/abc/" } });

    expect(paths.slice(0, 3)).toEqual([
      "/var/t/abc/discord-ipc-0",
      "/var/t/abc/discord-ipc-1",
      "/var/t/abc/discord-ipc-2",
    ]);
  });

  it("prefers the runtime dir, then temp dirs, and always ends at /tmp", () => {
    const paths = discordIpcSocketPaths({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/tmp" },
    });

    expect(paths[0]).toBe("/run/user/1000/discord-ipc-0");
    expect(paths).toContain("/tmp/discord-ipc-0");
    // `/tmp` came from TMPDIR; it must not also be appended as the fallback.
    expect(paths.filter((path) => path === "/tmp/discord-ipc-0")).toHaveLength(1);
  });

  it("skips the Linux sandbox layouts on macOS, where they are guaranteed misses", () => {
    const paths = discordIpcSocketPaths({ platform: "darwin", env: { TMPDIR: "/var/t/abc" } });

    // Ten slots under TMPDIR, ten under the /tmp fallback, and nothing else.
    expect(paths).toHaveLength(20);
    expect(paths.some((path) => path.includes("snap.discord"))).toBe(false);
  });

  it("looks inside sandbox runtime subdirectories", () => {
    const paths = discordIpcSocketPaths({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    });

    expect(paths).toContain("/run/user/1000/snap.discord/discord-ipc-0");
    expect(paths).toContain("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0");
    // A native install still wins: it is probed before any sandboxed one.
    expect(paths.indexOf("/run/user/1000/discord-ipc-0")).toBeLessThan(
      paths.indexOf("/run/user/1000/snap.discord/discord-ipc-0"),
    );
  });

  it("falls back to /tmp when the environment says nothing", () => {
    expect(discordIpcSocketPaths({ platform: "darwin", env: {} })[0]).toBe("/tmp/discord-ipc-0");
    expect(discordIpcSocketPaths({ platform: "darwin", env: { TMPDIR: "  " } })[0]).toBe(
      "/tmp/discord-ipc-0",
    );
  });
});

describe("readDiscordReadyUser", () => {
  it("reads the account out of a READY dispatch", () => {
    const user = readDiscordReadyUser({
      evt: "READY",
      data: { user: { id: "1", username: "michael", global_name: "Michael" } },
    });

    expect(user).toEqual({ id: "1", username: "michael", globalName: "Michael" });
    expect(discordAccountName(user)).toBe("Michael");
  });

  it("falls back to the username, and to nothing at all", () => {
    expect(
      discordAccountName(
        readDiscordReadyUser({ data: { user: { id: "1", username: "michael" } } }),
      ),
    ).toBe("michael");
    expect(discordAccountName(readDiscordReadyUser({ data: { user: { id: "1" } } }))).toBe(null);
    expect(discordAccountName(readDiscordReadyUser(null))).toBe(null);
  });
});

describe("isDiscordReadyFrame", () => {
  it("accepts only a READY dispatch on the frame opcode", () => {
    expect(
      isDiscordReadyFrame({ opcode: DISCORD_IPC_OPCODE.frame, payload: { evt: "READY" } }),
    ).toBe(true);
    expect(
      isDiscordReadyFrame({ opcode: DISCORD_IPC_OPCODE.handshake, payload: { evt: "READY" } }),
    ).toBe(false);
    expect(
      isDiscordReadyFrame({ opcode: DISCORD_IPC_OPCODE.frame, payload: { evt: "ERROR" } }),
    ).toBe(false);
  });
});
