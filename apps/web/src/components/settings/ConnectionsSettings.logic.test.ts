import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopWslState,
  type ServerProvider,
} from "@starcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  compareSavedConnectionRows,
  derivePiAccountConnections,
  derivePiApiConnections,
  formatPiUsageFailure,
  formatUsageRemaining,
  isFleetManagedConnectionTarget,
} from "./ConnectionsSettings.logic";

describe("formatUsageRemaining", () => {
  it("shows provider headroom and preserves unavailable data", () => {
    expect(formatUsageRemaining(undefined)).toBe("Not reported");
    expect(
      formatUsageRemaining({
        key: "five_hour",
        label: "5-hour",
        usedPercent: 37,
        resetsAt: null,
        windowMinutes: 300,
      }),
    ).toBe("63% remaining");
  });
});

const piAccount = (instanceId: string, displayName: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("pi"),
  instanceSource: "catalog",
  selectable: true,
  displayName,
  enabled: true,
  installed: true,
  status: "ready",
  checkedAt: new Date(0).toISOString(),
  auth: { status: "authenticated" },
  version: null,
  slashCommands: [],
  skills: [],
  models: [],
});

describe("Pi account connections", () => {
  it("keeps catalog accounts in Connections and labels them by model family", () => {
    const rows = derivePiAccountConnections([
      piAccount("ccc_openai_bbbbbbbbbbbbbbbbbbbbbbbb", "OpenAI Work"),
      piAccount("ccc_anthropic_aaaaaaaaaaaaaaaaaaaaaaaa", "Claude Personal"),
      { ...piAccount("pi", "Historical Pi"), instanceSource: "settings" },
      {
        ...piAccount("pi_custom", "OpenAI Custom"),
        instanceSource: "settings",
      },
      { ...piAccount("pi_openrouter", "OpenRouter"), instanceSource: "settings" },
    ]);
    expect(rows.map((row) => [row.familyLabel, row.provider.displayName])).toEqual([
      ["Claude", "Claude Personal"],
      ["GPT", "OpenAI Custom"],
      ["GPT", "OpenAI Work"],
    ]);
  });

  it("separates API-key providers from subscription connections", () => {
    const openRouter = {
      ...piAccount("pi_openrouter", "OpenRouter"),
      instanceSource: "settings" as const,
    };
    expect(derivePiAccountConnections([openRouter])).toEqual([]);
    expect(derivePiApiConnections([openRouter]).map((provider) => provider.displayName)).toEqual([
      "OpenRouter",
    ]);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

describe("compareSavedConnectionRows", () => {
  // Two servers on one host plus a third machine: the shape that made a rename
  // look like it had been dropped. Renaming the top row used to sort it away
  // and slide the identically named row into the position the user watched.
  // `label` is what the row displays — the alias when there is one.
  const hub = [
    { environmentId: "env-c", serverLabel: "seablue", label: "seablue" },
    { environmentId: "env-a", serverLabel: "seablue", label: "seablue" },
    { environmentId: "env-b", serverLabel: "richmond", label: "richmond" },
  ];

  function order(rows: ReadonlyArray<(typeof hub)[number]>): ReadonlyArray<string> {
    return rows.toSorted(compareSavedConnectionRows).map((row) => row.environmentId);
  }

  it("orders by the server label, not the alias the user just typed", () => {
    const before = order(hub);
    // Rename env-a to something that would sort last, and env-b to something
    // that would sort first, if the displayed name drove the order.
    const renamed = hub.map((row) =>
      row.environmentId === "env-a"
        ? { ...row, label: "zulu box" }
        : row.environmentId === "env-b"
          ? { ...row, label: "aardvark" }
          : row,
    );

    expect(before).toEqual(["env-b", "env-a", "env-c"]);
    expect(order(renamed)).toEqual(before);
  });

  it("holds a fixed order for two servers announcing the same host", () => {
    expect(order(hub.toReversed())).toEqual(["env-b", "env-a", "env-c"]);
  });
});

describe("isFleetManagedConnectionTarget", () => {
  it("identifies only fleet-derived bearer connections", () => {
    expect(
      isFleetManagedConnectionTarget("environment-a", {
        _tag: "BearerConnectionTarget",
        connectionId: "fleet:environment-a",
      }),
    ).toBe(true);
    expect(
      isFleetManagedConnectionTarget("environment-a", {
        _tag: "BearerConnectionTarget",
        connectionId: "saved:environment-a",
      }),
    ).toBe(false);
    expect(
      isFleetManagedConnectionTarget("environment-a", {
        _tag: "SshConnectionTarget",
        connectionId: "fleet:environment-a",
      }),
    ).toBe(false);
  });
});

describe("formatPiUsageFailure", () => {
  it("turns an expired credential into an explicit sign-in instruction", () => {
    expect(
      formatPiUsageFailure(
        "Starcode's saved authentication expired or was revoked. Sign in again here.",
      ),
    ).toEqual({
      needsSignIn: true,
      message:
        "Sign in again — Starcode's saved authentication expired. Other apps may still be signed in.",
    });
  });

  it("does not mislabel provider limits as authentication failures", () => {
    expect(formatPiUsageFailure("The subscription usage limit has been reached.")).toEqual({
      needsSignIn: false,
      message: "The subscription usage limit has been reached.",
    });
  });
});
