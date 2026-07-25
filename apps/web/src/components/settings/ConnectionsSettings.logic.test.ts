import type { DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyWslEnableSelection, compareSavedConnectionRows } from "./ConnectionsSettings.logic";

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
