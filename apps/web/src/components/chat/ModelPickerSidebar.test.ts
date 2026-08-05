import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { describeUnavailableInstance } from "./ModelPickerSidebar";

function entry(input: {
  readonly driver: string;
  readonly instanceId: string;
  readonly displayName: string;
  readonly status: ServerProvider["status"];
  readonly message?: string;
}) {
  const snapshot: ServerProvider = {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    displayName: input.displayName,
    enabled: true,
    installed: true,
    version: null,
    status: input.status,
    ...(input.message ? { message: input.message } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-08-04T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([snapshot])[0]!;
}

describe("describeUnavailableInstance", () => {
  it("directs Pi model limitations to the reachable Providers settings", () => {
    const tooltip = describeUnavailableInstance(
      entry({
        driver: "pi",
        instanceId: "pi",
        displayName: "Pi",
        status: "warning",
        message: "Some configured accounts expose fewer models.",
      }),
    );

    expect(tooltip).toContain("Some Pi accounts or models are unavailable");
    expect(tooltip).not.toContain("native Codex");
    expect(tooltip).not.toContain("Claude providers");
    expect(tooltip).toContain("Settings → Providers");
  });

  it("does not apply Pi-specific guidance to a native provider warning", () => {
    const tooltip = describeUnavailableInstance(
      entry({
        driver: "codex",
        instanceId: "codex",
        displayName: "Codex",
        status: "warning",
        message: "Update available.",
      }),
    );

    expect(tooltip).toBe("Codex — Limited. Update available.");
    expect(tooltip).not.toContain("Settings → Providers");
  });
});
