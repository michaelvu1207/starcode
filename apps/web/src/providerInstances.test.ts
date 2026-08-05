import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isLaunchableProviderDriver,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  resolveSelectableProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
  sortProviderInstanceEntries,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
  instanceSource?: ServerProvider["instanceSource"];
  selectable?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.instanceSource ? { instanceSource: input.instanceSource } : {}),
    ...(input.selectable === undefined ? {} : { selectable: input.selectable }),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("isProviderInstancePickerReady", () => {
  it("excludes legacy OpenCode snapshots from active provider entries", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    ]);

    expect(entries.map((entry) => entry.driverKind)).toEqual(["codex"]);
    expect(entries[0] && isProviderInstancePickerReady(entries[0])).toBe(false);
  });

  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "pi",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });

  it("accepts an enabled, available, ready instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: "pi" }),
    ]);

    expect(entry && isProviderInstancePickerReady(entry)).toBe(true);
  });
});

describe("isLaunchableProviderDriver", () => {
  it("keeps legacy provider kinds displayable without making them launchable", () => {
    expect(isLaunchableProviderDriver(ProviderDriverKind.make("pi"))).toBe(true);
    for (const driver of ["codex", "claudeAgent", "cursor", "grok", "opencode"]) {
      expect(isLaunchableProviderDriver(ProviderDriverKind.make(driver))).toBe(false);
    }
  });
});

describe("isProviderInstancePickerVisible", () => {
  it("keeps enabled Pi instances in the rail and hides disabled or legacy instances", () => {
    const [enabledEntry, disabledEntry, legacyEntry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: "pi" }),
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "pi_work",
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);

    expect(enabledEntry && isProviderInstancePickerVisible(enabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerVisible(disabledEntry)).toBe(false);
    expect(legacyEntry && isProviderInstancePickerVisible(legacyEntry)).toBe(false);
  });

  it("hides a compatibility alias while keeping its catalog account selectable", () => {
    const [alias, account] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "pi",
        instanceSource: "catalog",
        selectable: false,
      }),
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa",
        instanceSource: "catalog",
        selectable: true,
      }),
    ]);

    expect(alias && isProviderInstancePickerVisible(alias)).toBe(false);
    expect(alias && isProviderInstancePickerReady(alias)).toBe(false);
    expect(account && isProviderInstancePickerVisible(account)).toBe(true);
    expect(account && isProviderInstancePickerReady(account)).toBe(true);
  });
});

describe("applyProviderInstanceSettings", () => {
  it("uses settings when a streamed snapshot still reports a disabled default as enabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: "pi" }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [ProviderInstanceId.make("pi")]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: false,
        },
      },
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed custom instance snapshot as disabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "pi_work",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });

  it("keeps a live catalog-managed account enabled without persisting it in settings", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa",
        instanceSource: "catalog",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
      providers: {} as never,
    });

    expect(entry).toMatchObject({ enabled: true, selectable: true });
  });

  it("forces a stale legacy provider snapshot non-launchable without dropping its metadata", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_work",
        displayName: "Historical Claude",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [ProviderInstanceId.make("claude_work")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Historical Claude",
          enabled: true,
        },
      },
      providers: {} as never,
    });

    expect(entry).toMatchObject({
      instanceId: "claude_work",
      driverKind: "claudeAgent",
      displayName: "Historical Claude",
      enabled: false,
    });
  });

  it("marks and orders the selected account first for account-blind model routing", () => {
    const first = ProviderInstanceId.make("ccc_openai_aaaaaaaaaaaaaaaaaaaaaaaa");
    const active = ProviderInstanceId.make("ccc_openai_bbbbbbbbbbbbbbbbbbbbbbbb");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: first,
        instanceSource: "catalog",
      }),
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: active,
        instanceSource: "catalog",
      }),
    ]);
    const applied = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [active]: {
          driver: ProviderDriverKind.make("pi"),
          config: { activeForConnection: true },
        },
      },
      providers: {} as never,
    });

    expect(sortProviderInstanceEntries(applied).map((entry) => entry.instanceId)).toEqual([
      active,
      first,
    ]);
  });
});

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("pi_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: "pi" }),
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("pi_work");
    const fallback = ProviderInstanceId.make("pi");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("prefers a ready instance over an enabled one whose driver cannot start", () => {
    const notInstalled = ProviderInstanceId.make("pi_work");
    const ready = ProviderInstanceId.make("pi");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: ready }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(ready);
  });

  it("prefers an unprobed (warning) instance over one whose probe errored", () => {
    const notInstalled = ProviderInstanceId.make("pi_work");
    const unprobed = ProviderInstanceId.make("pi");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: unprobed,
        status: "warning",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(unprobed);
  });

  it("keeps a requested instance even when its probe errored", () => {
    const requested = ProviderInstanceId.make("pi_work");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: requested,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: "pi" }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("does not invent an errored instance as a new-user default", () => {
    const notInstalled = ProviderInstanceId.make("pi");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: notInstalled,
        status: "error",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBeUndefined();
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("pi");
    const unavailable = ProviderInstanceId.make("pi_work");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });

  it("never resolves a stale legacy provider, even when it is ready and requested", () => {
    const legacy = ProviderInstanceId.make("codex");
    const pi = ProviderInstanceId.make("pi");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: legacy }),
      provider({ provider: ProviderDriverKind.make("pi"), instanceId: pi }),
    ];

    expect(resolveSelectableProviderInstance(providers, legacy)).toBe(pi);
  });
});

describe("resolveProviderDriverKindForInstanceSelection", () => {
  it("maps custom provider instance ids back to their driver kind", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        displayName: "Claude OpenRouter",
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("claude_openrouter"),
      ),
    ).toBe("claudeAgent");
  });

  it("does not guess a provider kind when the instance selection is unknown", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("removed_instance"),
      ),
    ).toBeUndefined();
  });
});

describe("getDefaultProviderInstanceModel", () => {
  it("uses the instance's own models, not the default instance of the kind", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: [model("openai/gpt-5.5", true), model("claude-opus-4-8")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5")],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claude_openrouter")),
    ).toBe("claude-opus-4-8");
  });

  it("falls back to the driver default when the instance reports no models", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    const resolved = getDefaultProviderInstanceModel(
      providers,
      ProviderInstanceId.make("claudeAgent"),
    );
    expect(typeof resolved).toBe("string");
    expect(resolved?.length).toBeGreaterThan(0);
  });

  it("honors the instance's declared default before model-list order", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5"), model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claudeAgent"))).toBe(
      "claude-opus-4-8",
    );
  });

  it("returns undefined for an unknown instance", () => {
    expect(
      getDefaultProviderInstanceModel([], ProviderInstanceId.make("removed_instance")),
    ).toBeUndefined();
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  it("uses the only available Pi instance", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "pi",
        models: [model("openai-codex/gpt-5.6-sol", false, true)],
      }),
    ];

    expect(resolveDefaultProviderModelSelection(providers, null)).toEqual({
      instanceId: "pi",
      model: "openai-codex/gpt-5.6-sol",
    });
  });

  it("preserves a valid stored selection including its options", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "pi",
        models: [model("anthropic/claude-opus-5")],
      }),
    ];
    const stored = {
      instanceId: ProviderInstanceId.make("pi"),
      model: "anthropic/claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    };

    expect(resolveDefaultProviderModelSelection(providers, stored)).toBe(stored);
  });

  it("replaces a stale stored instance with the first ready instance and its model", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        models: [model("gpt-5.6")],
      }),
      provider({
        provider: ProviderDriverKind.make("pi"),
        instanceId: "pi",
        models: [model("anthropic/claude-opus-5", false, true)],
      }),
    ];

    expect(
      resolveDefaultProviderModelSelection(providers, {
        instanceId: ProviderInstanceId.make("removed-provider"),
        model: "stale-model",
      }),
    ).toEqual({ instanceId: "pi", model: "anthropic/claude-opus-5" });
  });

  it.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "replaces an unavailable stored instance deterministically",
    (requestedState) => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make("pi"),
          instanceId: "pi_work",
          models: [model("openai-codex/gpt-5.6-sol")],
          ...requestedState,
        }),
        provider({
          provider: ProviderDriverKind.make("pi"),
          instanceId: "pi",
          models: [model("anthropic/claude-opus-5", false, true)],
        }),
      ];

      expect(
        resolveDefaultProviderModelSelection(providers, {
          instanceId: ProviderInstanceId.make("pi_work"),
          model: "openai-codex/gpt-5.6-sol",
        }),
      ).toEqual({ instanceId: "pi", model: "anthropic/claude-opus-5" });
    },
  );

  it("returns no selection for empty, disabled, unavailable, or error-only profiles", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("pi"),
            instanceId: "pi",
            enabled: false,
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("pi"),
            instanceId: "pi",
            availability: "unavailable",
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("pi"),
            instanceId: "pi",
            status: "error",
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});
