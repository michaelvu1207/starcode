import * as NodePath from "node:path";

export function staleDevProcessPatterns(desktopDir) {
  return [
    `--starcode-dev-root=${desktopDir}`,
    `${NodePath.resolve(desktopDir, "../server/dist/bin.mjs")} --bootstrap-fd`,
  ];
}

export function cleanupStaleDevProcesses({ desktopDir, hostPlatform, signal, spawnSync }) {
  if (hostPlatform === "win32") return;

  for (const pattern of staleDevProcessPatterns(desktopDir)) {
    spawnSync("pkill", [`-${signal}`, "-f", "--", pattern], { stdio: "ignore" });
  }
}
