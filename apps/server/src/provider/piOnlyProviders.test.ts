import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";

describe("Pi-only provider runtime", () => {
  it("registers Pi as the only executable driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["pi"]);
  });

  it("hydrates Pi instances while ignoring retained legacy harness settings", () => {
    const piWork = ProviderInstanceId.make("pi_work");
    const legacyCodex = ProviderInstanceId.make("codex");
    const legacyClaude = ProviderInstanceId.make("claudeAgent");
    const config = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [piWork]: {
          driver: ProviderDriverKind.make("pi"),
          displayName: "Pi Work",
          config: {},
        },
        [legacyCodex]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Legacy Codex",
          config: {},
        },
        [legacyClaude]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Legacy Claude",
          config: {},
        },
      },
    });

    expect(Object.keys(config).sort()).toEqual(["pi", "pi_work"]);
    expect(config[piWork]?.driver).toBe("pi");
    expect(config[legacyCodex]).toBeUndefined();
    expect(config[legacyClaude]).toBeUndefined();
  });
});
