import { assert, describe, it } from "vite-plus/test";

import { cleanupStaleDevProcesses, staleDevProcessPatterns } from "./dev-process-cleanup.mjs";

describe("desktop dev process cleanup", () => {
  it("targets both the Electron app and its detached backend by worktree path", () => {
    assert.deepEqual(staleDevProcessPatterns("/repo/apps/desktop"), [
      "--starcode-dev-root=/repo/apps/desktop",
      "/repo/apps/server/dist/bin.mjs --bootstrap-fd",
    ]);
  });

  it("can force-kill a detached backend after its Electron parent exits", () => {
    const calls = [];
    cleanupStaleDevProcesses({
      desktopDir: "/repo/apps/desktop",
      hostPlatform: "darwin",
      signal: "KILL",
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
      },
    });

    assert.deepEqual(calls, [
      {
        command: "pkill",
        args: ["-KILL", "-f", "--", "--starcode-dev-root=/repo/apps/desktop"],
        options: { stdio: "ignore" },
      },
      {
        command: "pkill",
        args: ["-KILL", "-f", "--", "/repo/apps/server/dist/bin.mjs --bootstrap-fd"],
        options: { stdio: "ignore" },
      },
    ]);
  });

  it("does not use Unix process matching on Windows", () => {
    let called = false;
    cleanupStaleDevProcesses({
      desktopDir: "C:/repo/apps/desktop",
      hostPlatform: "win32",
      signal: "KILL",
      spawnSync: () => {
        called = true;
      },
    });
    assert.isFalse(called);
  });
});
