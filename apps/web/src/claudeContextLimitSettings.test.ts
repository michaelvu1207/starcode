import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type UnifiedSettings } from "@t3tools/contracts";

import {
  readClaudeContextLimitSetting,
  readClaudeContextLimitTokens,
} from "./claudeContextLimitSettings.ts";

const DEFAULT_INSTANCE = ProviderInstanceId.make("claudeAgent");
const WORK_INSTANCE = ProviderInstanceId.make("claude_work");

function makeSettings(input: {
  legacy?: string;
  instances?: Record<string, unknown>;
}): Pick<UnifiedSettings, "providers" | "providerInstances"> {
  return {
    providers: {
      claudeAgent: input.legacy === undefined ? {} : { contextLimitTokens: input.legacy },
    },
    providerInstances: Object.fromEntries(
      Object.entries(input.instances ?? {}).map(([id, config]) => [
        id,
        { driver: "claudeAgent", config },
      ]),
    ),
  } as unknown as Pick<UnifiedSettings, "providers" | "providerInstances">;
}

describe("readClaudeContextLimitSetting", () => {
  it("prefers the instance config over the legacy bucket", () => {
    const settings = makeSettings({
      legacy: "1m",
      instances: { claudeAgent: { contextLimitTokens: "400k" } },
    });

    expect(readClaudeContextLimitSetting(settings, DEFAULT_INSTANCE)).toBe("400k");
  });

  it("falls back to the legacy bucket only for the default instance", () => {
    const settings = makeSettings({ legacy: "800k" });

    expect(readClaudeContextLimitSetting(settings, DEFAULT_INSTANCE)).toBe("800k");
    expect(readClaudeContextLimitSetting(settings, WORK_INSTANCE)).toBeUndefined();
  });

  it("reads a custom instance's own config", () => {
    const settings = makeSettings({
      instances: { claude_work: { contextLimitTokens: "250000" } },
    });

    expect(readClaudeContextLimitSetting(settings, WORK_INSTANCE)).toBe("250000");
  });
});

describe("readClaudeContextLimitTokens", () => {
  it("resolves through the shared parser, defaulting to 600k", () => {
    expect(readClaudeContextLimitTokens(makeSettings({}), DEFAULT_INSTANCE)).toBe(600_000);
    expect(readClaudeContextLimitTokens(makeSettings({ legacy: "" }), DEFAULT_INSTANCE)).toBe(
      600_000,
    );
    expect(readClaudeContextLimitTokens(makeSettings({ legacy: "800k" }), DEFAULT_INSTANCE)).toBe(
      800_000,
    );
  });

  it("clamps rather than trusting an out-of-band value", () => {
    expect(readClaudeContextLimitTokens(makeSettings({ legacy: "10m" }), DEFAULT_INSTANCE)).toBe(
      1_000_000,
    );
  });
});
