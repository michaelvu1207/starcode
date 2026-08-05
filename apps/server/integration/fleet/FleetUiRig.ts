// @effect-diagnostics nodeBuiltinImport:off - subprocess fleet integration boundary
import * as NodeFSP from "node:fs/promises";

import { runG3ClientUnificationGate } from "./FleetGateScenarios.ts";
import { RealFleetGateDriver } from "./RealFleetGateDriver.ts";

const pairingFile = process.env.STARCODE_UI_RIG_PAIRING_FILE?.trim();
const infoFile = process.env.STARCODE_UI_RIG_INFO_FILE?.trim();
const webBaseUrl = process.env.STARCODE_UI_RIG_WEB_URL?.trim();

if (!pairingFile || !infoFile || !webBaseUrl) {
  throw new Error(
    "STARCODE_UI_RIG_PAIRING_FILE, STARCODE_UI_RIG_INFO_FILE, and STARCODE_UI_RIG_WEB_URL are required.",
  );
}

process.env.VITE_DEV_SERVER_URL = webBaseUrl;
const driver = await RealFleetGateDriver.start();

try {
  await runG3ClientUnificationGate(driver, {
    timeoutMilliseconds: 20_000,
    pollIntervalMilliseconds: 100,
  });
  await driver.writeBrowserPairingUrl({
    node: "alpha",
    webBaseUrl,
    destinationPath: pairingFile,
  });
  await NodeFSP.writeFile(
    infoFile,
    `${JSON.stringify(
      {
        alphaHttpBaseUrl: driver.harness.nodes.alpha.baseUrl,
        alphaWsBaseUrl: driver.harness.nodes.alpha.baseUrl.replace(/^http/, "ws"),
        rootDir: driver.harness.rootDir,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write("Fleet UI rig ready.\n");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} catch (cause) {
  if (process.env.STARCODE_UI_RIG_HOLD_ON_FAILURE === "1") {
    await NodeFSP.writeFile(
      infoFile,
      `${JSON.stringify(
        {
          alphaHttpBaseUrl: driver.harness.nodes.alpha.baseUrl,
          alphaWsBaseUrl: driver.harness.nodes.alpha.baseUrl.replace(/^http/, "ws"),
          rootDir: driver.harness.rootDir,
          failed: true,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    process.stdout.write("Fleet UI rig failed and is held for inspection.\n");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
  throw cause;
} finally {
  await driver.dispose();
}
